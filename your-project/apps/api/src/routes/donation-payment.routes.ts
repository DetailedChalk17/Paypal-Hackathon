import { Router } from "express";

import {
  requireAuth,
  requireRole,
} from "../middleware/auth.middleware";

import {
  reserveRefundRequest,
  updateRefundFromPayPalResponse,
} from "../services/refund.service";

import { prisma } from "../lib/prisma";
import { appendEvent, appendEventInTransaction } from "../services/ledger.service";

const router = Router();

function isValidUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

// ==========================================
// POST /donations/create-order
// Create a donation and its PayPal order
// ==========================================

router.post(
  "/create-order",
  requireAuth,
  requireRole("donor"),
  async (req, res) => {
    const { campaignId, amountCents } = req.body ?? {};

    if (!isValidUuid(campaignId)) {
      return res.status(400).json({
        error: "Invalid campaign ID",
      });
    }

    if (
      !Number.isSafeInteger(amountCents) ||
      amountCents <= 0
    ) {
      return res.status(400).json({
        error: "Donation amount must be a positive number of cents",
      });
    }

    try {
      // 1. Check that the campaign exists and accepts donations.
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: {
          id: true,
          status: true,
          currency: true,
        },
      });

      if (!campaign) {
        return res.status(404).json({
          error: "Campaign not found",
        });
      }

      if (campaign.status !== "active") {
        return res.status(409).json({
          error: "This campaign is not accepting donations",
        });
      }

      if (campaign.currency !== "USD") {
        return res.status(400).json({
          error: "Only USD donations are supported",
        });
      }

      // 2. Create a pending donation for the logged-in donor.
      const donation = await prisma.donation.create({
        data: {
          campaignId,
          donorId: req.user!.id,
          amountCents,
          status: "pending",
        },
      });

      try {
        // 3. Load the PayPal package and create the order.
        const { createOrder } = await import(
          "@your-project/paypal"
        );

        const frontendUrl =
          process.env.FRONTEND_URL ?? "http://localhost:5173";
        const returnUrl = new URL("/paypal/return", frontendUrl);
        returnUrl.searchParams.set("donationId", donation.id);
        const cancelUrl = new URL("/paypal/cancel", frontendUrl);
        cancelUrl.searchParams.set("donationId", donation.id);

        const order = await createOrder({
          campaignId,
          amountCents,
          // Stable for retries of this donation's order request.
          requestId: donation.id,
          returnUrl: returnUrl.toString(),
          cancelUrl: cancelUrl.toString(),
        });

        // 4. Save the PayPal Order ID.
        await prisma.donation.update({
          where: { id: donation.id },
          data: {
            paypalOrderId: order.orderId,
          },
        });

        // 5. Record the order creation in the ledger.
        let ledgerRecorded = true;

        try {
          await appendEvent(
            "DONATION_ORDER_CREATED",
            donation.id,
            {
              campaignId,
              donorId: req.user!.id,
              amountCents,
              paypalOrderId: order.orderId,
            }
          );
        } catch (ledgerError) {
          ledgerRecorded = false;
          console.error(
            "Failed to record donation order in ledger:",
            ledgerError
          );
        }

        return res.status(201).json({
          donationId: donation.id,
          orderId: order.orderId,
          approvalUrl: order.approvalUrl,
          status: "pending",
          ledgerRecorded,
        });
      } catch (paypalError) {
        // PayPal order creation failed.
        await prisma.donation.update({
          where: { id: donation.id },
          data: { status: "failed" },
        });

        try {
          await appendEvent(
            "DONATION_ORDER_FAILED",
            donation.id,
            {
              campaignId,
              amountCents,
            }
          );
        } catch (ledgerError) {
          console.error("Failed to record order failure:", ledgerError);
        }

        throw paypalError;
      }
    } catch (error) {
      console.error("Create donation order error:", error);

      return res.status(502).json({
        error: "Unable to create PayPal donation order",
      });
    }
  }
);

// ==========================================
// POST /donations/:donationId/capture
// Capture an approved PayPal order
// ==========================================

router.post(
  "/:donationId/capture",
  requireAuth,
  requireRole("donor"),
  async (req, res) => {
    const { donationId } = req.params;

    if (!isValidUuid(donationId)) {
      return res.status(400).json({
        error: "Invalid donation ID",
      });
    }

    try {
      // 1. Find the donation.
      const donation = await prisma.donation.findUnique({
        where: { id: donationId },
      });

      if (!donation) {
        return res.status(404).json({
          error: "Donation not found",
        });
      }

      // 2. Only the donor who created it can capture it.
      if (donation.donorId !== req.user!.id) {
        return res.status(403).json({
          error: "You cannot capture this donation",
        });
      }

      // 3. Make repeated capture requests safe.
      if (donation.status === "completed") {
        return res.status(200).json({
          donationId: donation.id,
          orderId: donation.paypalOrderId,
          captureId: donation.paypalCaptureId,
          status: "completed",
          alreadyCaptured: true,
        });
      }

      if (
        donation.status !== "pending" ||
        !donation.paypalOrderId
      ) {
        return res.status(409).json({
          error: "Donation cannot be captured",
        });
      }

      // 4. Capture through PayPal.
      const { captureOrder } = await import(
        "@your-project/paypal"
      );

      const result = await captureOrder({
        orderId: donation.paypalOrderId,
        expectedAmountCents: donation.amountCents,
        requestId: `c-${donation.id}`,
      });

      // 5. Handle successful capture.
      if (result.captureStatus === "COMPLETED") {
        let ledgerRecorded = false;

        const updatedDonation = await prisma.$transaction(async (tx) => {
          const current = await tx.donation.findUnique({
            where: { id: donation.id },
          });

          if (!current) {
            throw new Error("Donation disappeared during capture.");
          }

          if (
            current.paypalCaptureId &&
            current.paypalCaptureId !== result.captureId
          ) {
            throw new Error(
              "Donation is already associated with a different capture ID."
            );
          }

          // A genuine successful capture may recover a previously denied
          // capture, but must never overwrite a refund.
          if (
            current.status === "pending" ||
            current.status === "failed"
          ) {
            const changed = await tx.donation.updateMany({
              where: {
                id: donation.id,
                status: { in: ["pending", "failed"] },
              },
              data: {
                paypalCaptureId: result.captureId,
                status: "completed",
              },
            });

            if (changed.count === 1) {
              await appendEventInTransaction(
                tx,
                "DONATION_COMPLETED",
                donation.id,
                {
                  paypalOrderId: result.orderId,
                  paypalCaptureId: result.captureId,
                  amountCents: result.amountCents,
                  currencyCode: result.currencyCode,
                }
              );

              ledgerRecorded = true;
            }
          } else if (
            current.status === "completed" &&
            !current.paypalCaptureId
          ) {
            // Backfill the capture ID without creating a duplicate event.
            await tx.donation.updateMany({
              where: {
                id: donation.id,
                status: "completed",
                paypalCaptureId: null,
              },
              data: { paypalCaptureId: result.captureId },
            });
          }

          const latest = await tx.donation.findUnique({
            where: { id: donation.id },
          });

          if (!latest) {
            throw new Error("Donation could not be reloaded after capture.");
          }

          return latest;
        });

        return res.status(200).json({
          donationId: updatedDonation.id,
          orderId: result.orderId,
          captureId: result.captureId,
          amountCents: result.amountCents,
          status: updatedDonation.status,
          ledgerRecorded,
        });
      }

      // 6. PayPal reports that capture is still pending.
      if (result.captureStatus === "PENDING") {
        const latest = await prisma.$transaction(async (tx) => {
          await tx.donation.updateMany({
            where: {
              id: donation.id,
              status: "pending",
            },
            data: {
              paypalCaptureId: result.captureId,
            },
          });

          return tx.donation.findUnique({
            where: { id: donation.id },
          });
        });

        if (!latest) {
          throw new Error("Donation could not be reloaded after capture.");
        }

        const responseStatus =
          latest.status === "pending"
            ? 202
            : latest.status === "completed" ||
                latest.status === "refunded"
              ? 200
              : 409;

        return res.status(responseStatus).json({
          donationId: donation.id,
          captureId: result.captureId,
          status: latest.status,
          message:
            latest.status === "pending"
              ? "Payment capture is still processing"
              : "Donation state was updated by another PayPal event",
        });
      }

      // 7. PayPal explicitly denied the capture.
      if (result.captureStatus === "DENIED") {
        const latest = await prisma.$transaction(async (tx) => {
          const changed = await tx.donation.updateMany({
            where: {
              id: donation.id,
              status: "pending",
            },
            data: {
              status: "failed",
              paypalCaptureId: result.captureId,
            },
          });

          if (changed.count === 1) {
            await appendEventInTransaction(
              tx,
              "DONATION_CAPTURE_DENIED",
              donation.id,
              {
                paypalOrderId: result.orderId,
                paypalCaptureId: result.captureId,
              }
            );
          }

          return tx.donation.findUnique({
            where: { id: donation.id },
          });
        });

        if (!latest) {
          throw new Error("Donation could not be reloaded after denial.");
        }

        if (latest.status !== "failed") {
          return res.status(200).json({
            donationId: donation.id,
            status: latest.status,
            message: "A newer PayPal event already updated this donation",
          });
        }

        return res.status(402).json({
          donationId: donation.id,
          status: "failed",
          error: "PayPal denied the payment capture",
        });
      }

      return res.status(502).json({
        error: "Unexpected PayPal capture status",
      });
    } catch (error) {
      console.error("Capture donation error:", error);

      return res.status(502).json({
        error: "Unable to capture PayPal donation",
      });
    }
  }
);


// ==========================================
// POST /donations/:donationId/refunds
//
// Initiate a full or partial PayPal refund.
// Reviewer-only operation.
// ==========================================

router.post(
  "/:donationId/refunds",
  requireAuth,
  requireRole("reviewer"),
  async (req, res) => {
    const donationId = req.params.donationId;

    if (!isValidUuid(donationId)) {
      return res.status(400).json({
        error: "Invalid donation ID",
      });
    }

    const idempotencyKey = req.get("Idempotency-Key");

    if (!idempotencyKey?.trim()) {
      return res.status(400).json({
        error: "Idempotency-Key header is required",
      });
    }

    const body = req.body;

    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body)
    ) {
      return res.status(400).json({
        error: "A JSON request body is required",
      });
    }

    const amountCents = body.amountCents;
    const noteToPayer = body.noteToPayer;

    if (
      amountCents !== undefined &&
      typeof amountCents !== "number"
    ) {
      return res.status(400).json({
        error: "amountCents must be a number",
      });
    }

    if (
      noteToPayer !== undefined &&
      typeof noteToPayer !== "string"
    ) {
      return res.status(400).json({
        error: "noteToPayer must be a string",
      });
    }

    try {
      // 1. Reserve the refund before calling PayPal.
      const reservation = await reserveRefundRequest({
        donationId,
        idempotencyKey,
        amountCents,
        noteToPayer,
      });

      if (!reservation.ok) {
        return res.status(reservation.statusCode).json({
          error: reservation.error,
        });
      }

      const refund = reservation.refund;

      // 2. Repeated requests return the existing record.
      // Never initiate another PayPal call for a duplicate key.
      if (reservation.duplicate) {
        const awaitingResolution = [
          "processing",
          "pending",
          "reconciliation_required",
        ].includes(refund.status);

        return res.status(
          awaitingResolution ? 202 : 200
        ).json({
          message: "Existing refund request returned",
          duplicate: true,
          refund: {
            id: refund.id,
            paypalRefundId: refund.paypalRefundId,
            amountCents: refund.amountCents,
            status: refund.status,
            completedAt: refund.completedAt,
          },
        });
      }

      // 3. Send the refund request using the stable Refund UUID.
      let paypalResult;

      try {
        const { refundCapture } =
          await import("@your-project/paypal");

        paypalResult = await refundCapture({
          captureId: reservation.captureId,
          requestId: refund.id,
          customId: refund.id,
          amountCents: refund.amountCents,
          ...(refund.noteToPayer
            ? { noteToPayer: refund.noteToPayer }
            : {}),
        });
      } catch (paypalError) {
        console.error(
          "PayPal refund request outcome is uncertain:",
          paypalError
        );

        // A timeout or provider error does not prove
        // that the refund was not processed.
        try {
          const updated =
            await updateRefundFromPayPalResponse(
              refund.id,
              { status: "UNKNOWN" },
              paypalError instanceof Error
                ? paypalError.message
                : "Unknown PayPal error"
            );

          return res.status(202).json({
            message:
              "Refund outcome is uncertain and requires reconciliation",
            refund: {
              id: updated.id,
              amountCents: updated.amountCents,
              status: updated.status,
            },
          });
        } catch (persistenceError) {
          console.error(
            "Failed to persist uncertain refund outcome:",
            persistenceError
          );

          return res.status(202).json({
            message:
              "Refund outcome is uncertain. The existing reservation must be reconciled.",
            refundId: refund.id,
            status: refund.status,
          });
        }
      }

      // 4. Persist PayPal's response.
      let updated;

      try {
        updated = await updateRefundFromPayPalResponse(
          refund.id,
          paypalResult
        );
      } catch (persistenceError) {
        console.error(
          "Failed to persist PayPal refund response:",
          persistenceError
        );

        return res.status(202).json({
          message:
            "PayPal returned a response, but local reconciliation is pending",
          refundId: refund.id,
          status: "processing",
        });
      }

      // 5. Return the provider-confirmed state.
      const awaitingResolution = [
        "processing",
        "pending",
        "reconciliation_required",
      ].includes(updated.status);

      return res.status(
        awaitingResolution ? 202 : 200
      ).json({
        message: "Refund request processed",
        refund: {
          id: updated.id,
          paypalRefundId: updated.paypalRefundId,
          amountCents: updated.amountCents,
          status: updated.status,
          completedAt: updated.completedAt,
        },
      });
    } catch (error) {
      console.error("Create refund error:", error);

      return res.status(500).json({
        error: "Unable to create refund request",
      });
    }
  }
);


export default router;