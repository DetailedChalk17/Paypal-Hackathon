import express, { Router } from "express";
import { Prisma } from "@prisma/client";

import { prisma } from "../lib/prisma";
import { appendEventInTransaction } from "../services/ledger.service";
import {
  recalculateOrganizationTrustScore,
} from "../services/trust-score.service";
import {
  processPayoutWebhookEvent,
} from "../services/payout-webhook.service";

type PayPalWebhookHeaders = {
  transmissionId: string;
  transmissionTime: string;
  transmissionSignature: string;
  certUrl: string;
  authAlgo: string;
};

type PayPalWebhookSignatureVerifier = (
  headers: PayPalWebhookHeaders,
  rawBody: string
) => Promise<boolean>;

// ==========================================
// PAYPAL EVENT TYPES
// ==========================================

type PayPalEvent = {
  id: string;
  event_type: string;
  resource?: Record<string, unknown>;
};

// ==========================================
// HELPERS
// ==========================================

function asObject(
  value: unknown
): Record<string, unknown> | null {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    return value as Record<string, unknown>;
  }

  return null;
}

function getString(
  object: Record<string, unknown> | null,
  key: string
): string | undefined {
  const value = object?.[key];
  return typeof value === "string" ? value : undefined;
}

function getHeader(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Convert PayPal's decimal money value to integer cents safely. */
function amountToCents(value: unknown): number | null {
  const money = asObject(value);
  const rawValue = getString(money, "value");

  if (!rawValue || !/^\d+(\.\d{1,2})?$/.test(rawValue)) {
    return null;
  }

  const [whole, fraction = ""] = rawValue.split(".");
  const cents =
    Number(whole) * 100 +
    Number(fraction.padEnd(2, "0"));

  return Number.isSafeInteger(cents) ? cents : null;
}

function getRelatedIds(
  resource: Record<string, unknown> | null
): Record<string, unknown> | null {
  const supplementaryData = asObject(
    resource?.supplementary_data
  );

  return asObject(supplementaryData?.related_ids);
}

function extractIdFromLink(
  resource: Record<string, unknown> | null,
  relation: string,
  resourceName: "captures" | "orders"
): string | undefined {
  const links = Array.isArray(resource?.links)
    ? resource.links
    : [];

  for (const candidate of links) {
    const link = asObject(candidate);

    if (getString(link, "rel") !== relation) {
      continue;
    }

    const href = getString(link, "href");

    const match = href?.match(
      new RegExp(`/${resourceName}/([^/?#]+)`, "i")
    );

    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

function getCaptureIdFromRefund(
  resource: Record<string, unknown> | null
): string | undefined {
  const relatedIds = getRelatedIds(resource);

  return (
    getString(relatedIds, "capture_id") ??
    extractIdFromLink(resource, "up", "captures")
  );
}

function getOrderIdFromCapture(
  resource: Record<string, unknown> | null
): string | undefined {
  const relatedIds = getRelatedIds(resource);

  return (
    getString(relatedIds, "order_id") ??
    extractIdFromLink(resource, "up", "orders")
  );
}

function getPayoutBatchId(
  resource: Record<string, unknown> | null
): string | undefined {
  const batchHeader = asObject(resource?.batch_header);
  const payoutBatchHeader = asObject(
    resource?.payout_batch_header
  );
  const relatedIds = getRelatedIds(resource);

  return (
    getString(batchHeader, "payout_batch_id") ??
    getString(payoutBatchHeader, "payout_batch_id") ??
    getString(resource, "payout_batch_id") ??
    getString(relatedIds, "payout_batch_id")
  );
}

// ==========================================
// SUPPORTED EVENTS
// ==========================================

const supportedEvents = new Set([
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
]);

// ==========================================
// POST /webhooks/paypal
// ==========================================

export function createPayPalWebhookRouter(
  signatureVerifier?: PayPalWebhookSignatureVerifier
) {
  const router = Router();

  router.post(
    "/paypal",
    express.raw({
      type: "application/json",
      limit: "1mb",
    }),
    async (req, res) => {
      let webhookEventId: string | undefined;
      let webhookEventType: string | undefined;
      let webhookResource: Record<string, unknown> | null = null;

      // Recalculation happens after the payout transaction commits.
      let trustScoreOrganizationId: string | undefined;

      // Payout item events remain unprocessed until recalculation succeeds.
      let deferWebhookProcessedAt = false;

      try {
        // --------------------------------------
        // PARSE REQUEST
        // --------------------------------------

        if (!Buffer.isBuffer(req.body)) {
          return res.status(400).json({
            error: "Expected raw JSON webhook body",
          });
        }

        const rawBody = req.body.toString("utf8");

        let event: PayPalEvent;

        try {
          event = JSON.parse(rawBody) as PayPalEvent;
        } catch {
          return res.status(400).json({
            error: "Invalid JSON webhook body",
          });
        }

        if (
          typeof event.id !== "string" ||
          !event.id.trim() ||
          typeof event.event_type !== "string" ||
          !event.event_type.trim()
        ) {
          return res.status(400).json({
            error: "Invalid PayPal event structure",
          });
        }

        webhookEventId = event.id;
        webhookEventType = event.event_type;
        webhookResource = asObject(event.resource);

        const resource = webhookResource;
        const resourceId = getString(resource, "id");

        // --------------------------------------
        // VERIFY PAYPAL SIGNATURE
        // --------------------------------------

        const headers = {
          transmissionId:
            getHeader(
              req.headers["paypal-transmission-id"]
            ) ?? "",

          transmissionTime:
            getHeader(
              req.headers["paypal-transmission-time"]
            ) ?? "",

          transmissionSignature:
            getHeader(
              req.headers["paypal-transmission-sig"]
            ) ?? "",

          certUrl:
            getHeader(req.headers["paypal-cert-url"]) ?? "",

          authAlgo:
            getHeader(req.headers["paypal-auth-algo"]) ?? "",
        };

        // Production uses PayPal's real signature verifier.
        // Tests can inject a controlled verifier through the factory.
        const verify =
          signatureVerifier ??
          (await import("@your-project/paypal")).verifyWebhookSignature;

        const isValid = await verify(headers, rawBody);

        if (!isValid) {
          return res.status(401).json({
            error: "Invalid PayPal webhook signature",
          });
        }

        // A correctly signed event we do not handle can be acknowledged.
        if (!supportedEvents.has(event.event_type)) {
          return res.status(200).json({
            message: "Event ignored",
            eventType: event.event_type,
          });
        }

        // --------------------------------------
        // PROCESS EVENT TRANSACTIONALLY
        // --------------------------------------

        await prisma.$transaction(
          async (tx) => {
            await tx.webhookEvent.create({
              data: {
                paypalEventId: event.id,
                eventType: event.event_type,
                resourceId,
                payload:
                  event as unknown as Prisma.InputJsonObject,
              },
            });

            // ======================================
            // DONATION: CAPTURE COMPLETED
            // ======================================

            if (
              event.event_type === "PAYMENT.CAPTURE.COMPLETED"
            ) {
              const orderId = getOrderIdFromCapture(resource);
              const captureId = resourceId;
              const amountCents = amountToCents(resource?.amount);

              const amountObject = asObject(resource?.amount);

              const currencyCode = getString(
                amountObject,
                "currency_code"
              );

              const captureStatus = getString(
                resource,
                "status"
              );

              if (!orderId || !captureId) {
                throw new Error(
                  "Capture event is missing its order ID or capture ID"
                );
              }

              if (captureStatus !== "COMPLETED") {
                throw new Error(
                  "PayPal capture is not completed"
                );
              }

              if (amountCents === null || !currencyCode) {
                throw new Error(
                  "Capture event has an invalid amount"
                );
              }

              const donation = await tx.donation.findUnique({
                where: { paypalOrderId: orderId },
                include: {
                  campaign: {
                    select: { currency: true },
                  },
                },
              });

              if (!donation) {
                throw new Error(
                  `No donation found for PayPal order ${orderId}`
                );
              }

              if (
                amountCents !== donation.amountCents ||
                currencyCode !== donation.campaign.currency
              ) {
                throw new Error(
                  "PayPal capture amount or currency does not match the donation"
                );
              }

              if (
                donation.paypalCaptureId &&
                donation.paypalCaptureId !== captureId
              ) {
                throw new Error(
                  "Donation is already associated with a different capture ID"
                );
              }

              // Do not undo a refund if an older completion event arrives late.
              if (donation.status !== "refunded") {
                if (donation.status !== "completed") {
                  await tx.donation.update({
                    where: { id: donation.id },
                    data: {
                      status: "completed",
                      paypalCaptureId: captureId,
                    },
                  });

                  await appendEventInTransaction(
                    tx,
                    "DONATION_COMPLETED",
                    donation.id,
                    {
                      paypalOrderId: orderId,
                      paypalCaptureId: captureId,
                      amountCents,
                      currencyCode,
                      source: "paypal_webhook",
                    }
                  );
                } else if (!donation.paypalCaptureId) {
                  // Backfill capture ID without duplicating ledger event.
                  await tx.donation.update({
                    where: { id: donation.id },
                    data: { paypalCaptureId: captureId },
                  });
                }
              }
            }

            // ======================================
            // DONATION: CAPTURE DENIED
            // ======================================

            else if (
              event.event_type === "PAYMENT.CAPTURE.DENIED"
            ) {
              const orderId = getOrderIdFromCapture(resource);
              const captureId = resourceId;

              if (!orderId && !captureId) {
                throw new Error(
                  "Denied capture event is missing its order/capture ID"
                );
              }

              const donation = await tx.donation.findFirst({
                where: {
                  OR: [
                    ...(orderId
                      ? [{ paypalOrderId: orderId }]
                      : []),

                    ...(captureId
                      ? [{ paypalCaptureId: captureId }]
                      : []),
                  ],
                },
              });

              if (!donation) {
                throw new Error(
                  "No donation found for denied PayPal capture"
                );
              }

              if (
                donation.paypalCaptureId &&
                captureId &&
                donation.paypalCaptureId !== captureId
              ) {
                throw new Error(
                  "Denied event capture ID does not match the donation"
                );
              }

              // Never downgrade completed or refunded payments.
              if (donation.status === "pending") {
                await tx.donation.update({
                  where: { id: donation.id },
                  data: {
                    status: "failed",
                    ...(captureId
                      ? { paypalCaptureId: captureId }
                      : {}),
                  },
                });

                await appendEventInTransaction(
                  tx,
                  "DONATION_CAPTURE_DENIED",
                  donation.id,
                  {
                    paypalOrderId: orderId ?? null,
                    paypalCaptureId: captureId ?? null,
                    source: "paypal_webhook",
                  }
                );
              }
            }

            // ======================================
            // DONATION: CAPTURE REFUNDED
            // ======================================

            else if (
              event.event_type === "PAYMENT.CAPTURE.REFUNDED"
            ) {
              const captureId = getCaptureIdFromRefund(resource);
              const refundId = resourceId;

              const refundAmountCents = amountToCents(
                resource?.amount
              );

              const refundMoney = asObject(resource?.amount);

              const refundCurrency = getString(
                refundMoney,
                "currency_code"
              );

              const refundStatus = getString(
                resource,
                "status"
              );

              if (!captureId || !refundId) {
                throw new Error(
                  "Refund event is missing its refund ID or original capture ID"
                );
              }

              if (
                refundStatus &&
                refundStatus !== "COMPLETED"
              ) {
                throw new Error(
                  "PayPal refund is not completed"
                );
              }

              if (
                refundAmountCents === null ||
                !refundCurrency
              ) {
                throw new Error(
                  "Refund event has an invalid amount"
                );
              }

              const donation = await tx.donation.findUnique({
                where: { paypalCaptureId: captureId },
                include: {
                  campaign: {
                    select: { currency: true },
                  },
                },
              });

              if (!donation) {
                throw new Error(
                  `No donation found for PayPal capture ${captureId}`
                );
              }

              if (
                refundCurrency !== donation.campaign.currency
              ) {
                throw new Error(
                  "Refund currency does not match donation currency"
                );
              }

              const sellerBreakdown = asObject(
                resource?.seller_payable_breakdown
              );

              const totalRefundedMoney = asObject(
                sellerBreakdown?.total_refunded_amount
              );

              const reportedTotalRefunded = amountToCents(
                sellerBreakdown?.total_refunded_amount
              );

              const reportedTotalCurrency = getString(
                totalRefundedMoney,
                "currency_code"
              );

              let totalRefundedCents: number;

              if (reportedTotalRefunded !== null) {
                if (
                  reportedTotalCurrency !==
                  donation.campaign.currency
                ) {
                  throw new Error(
                    "Cumulative refund currency does not match donation currency"
                  );
                }

                totalRefundedCents = reportedTotalRefunded;
              } else {
                // Fallback for payloads without total_refunded_amount:
                // sum completed refund events already stored in this transaction.
                const refundEvents =
                  await tx.webhookEvent.findMany({
                    where: {
                      eventType: "PAYMENT.CAPTURE.REFUNDED",
                    },
                    select: { payload: true },
                  });

                totalRefundedCents = refundEvents.reduce(
                  (total, row) => {
                    const storedEvent = asObject(row.payload);

                    const storedResource = asObject(
                      storedEvent?.resource
                    );

                    const storedCaptureId =
                      getCaptureIdFromRefund(storedResource);

                    const storedCurrency = getString(
                      asObject(storedResource?.amount),
                      "currency_code"
                    );

                    if (
                      storedCaptureId !== captureId ||
                      storedCurrency !== donation.campaign.currency
                    ) {
                      return total;
                    }

                    return (
                      total +
                      (amountToCents(storedResource?.amount) ?? 0)
                    );
                  },
                  0
                );
              }

              const fullyRefunded =
                totalRefundedCents >= donation.amountCents;

              if (
                fullyRefunded &&
                donation.status !== "refunded"
              ) {
                await tx.donation.update({
                  where: { id: donation.id },
                  data: { status: "refunded" },
                });
              }

              await appendEventInTransaction(
                tx,
                fullyRefunded
                  ? "DONATION_REFUNDED"
                  : "DONATION_PARTIALLY_REFUNDED",
                donation.id,
                {
                  paypalCaptureId: captureId,
                  paypalRefundId: refundId,
                  refundAmountCents,
                  totalRefundedCents,
                  source: "paypal_webhook",
                }
              );
            }

            // ======================================
            // PAYOUT: BATCH OR ITEM WEBHOOK
            // ======================================

            else if (
              event.event_type ===
                "PAYMENT.PAYOUTSBATCH.SUCCESS" ||
              event.event_type ===
                "PAYMENT.PAYOUTS-ITEM.SUCCEEDED"
            ) {
              const result = await processPayoutWebhookEvent(
                tx,
                event.event_type,
                resource
              );

              if (
                result.action === "item_succeeded" &&
                result.organizationId
              ) {
                trustScoreOrganizationId =
                  result.organizationId;

                deferWebhookProcessedAt = true;
              }
            }

            // A payout item event is marked processed only after
            // trust-score recalculation succeeds outside this transaction.
            if (!deferWebhookProcessedAt) {
              await tx.webhookEvent.update({
                where: { paypalEventId: event.id },
                data: { processedAt: new Date() },
              });
            }
          },
          {
            maxWait: 10000,
            timeout: 35000,
          }
        );

        // ======================================
        // TRUST SCORE RECALCULATION
        // ======================================

        // Run only after payout, milestone and ledger changes commit.
        if (trustScoreOrganizationId) {
          await recalculateOrganizationTrustScore(
            trustScoreOrganizationId
          );

          await prisma.webhookEvent.update({
            where: { paypalEventId: event.id },
            data: { processedAt: new Date() },
          });
        }

        return res.status(200).json({
          message: "Webhook processed successfully",
          eventId: event.id,
        });
      } catch (error) {
        // ======================================
        // DUPLICATE WEBHOOK / RECOVERY
        // ======================================

        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          webhookEventId
        ) {
          const existing = await prisma.webhookEvent.findUnique({
            where: { paypalEventId: webhookEventId },
            select: {
              id: true,
              processedAt: true,
            },
          });

          if (existing?.processedAt) {
            return res.status(200).json({
              message: "Duplicate webhook ignored",
              eventId: webhookEventId,
            });
          }

          // The payout transaction may have committed while
          // trust-score recalculation failed afterward.
          // Recover that post-transaction step on PayPal retry.
          if (
            existing &&
            webhookEventType ===
              "PAYMENT.PAYOUTS-ITEM.SUCCEEDED"
          ) {
            try {
              const batchId = getPayoutBatchId(
                webhookResource
              );

              if (!batchId) {
                throw new Error(
                  "Payout item retry is missing its batch ID"
                );
              }

              const payout = await prisma.payout.findUnique({
                where: { paypalBatchId: batchId },
                include: {
                  milestone: {
                    include: {
                      campaign: {
                        select: {
                          organizationId: true,
                        },
                      },
                    },
                  },
                },
              });

              if (!payout) {
                throw new Error(
                  `No payout found for PayPal batch ${batchId}`
                );
              }

              await recalculateOrganizationTrustScore(
                payout.milestone.campaign.organizationId
              );

              await prisma.webhookEvent.update({
                where: { paypalEventId: webhookEventId },
                data: { processedAt: new Date() },
              });

              return res.status(200).json({
                message: "Payout webhook recovery completed",
                eventId: webhookEventId,
              });
            } catch (recoveryError) {
              console.error(
                "Payout webhook recovery failed:",
                recoveryError
              );
            }
          }
        }

        console.error(
          "PayPal webhook processing failed:",
          error
        );

        return res.status(500).json({
          error: "Webhook processing failed",
        });
      }
    }
  );

  return router;
}

const router = createPayPalWebhookRouter();

export default router;