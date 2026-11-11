import type { Prisma, Refund } from "@prisma/client";

import { prisma } from "../lib/prisma";
import { appendEventInTransaction } from "./ledger.service";

type ReserveRefundInput = {
  donationId: string;
  idempotencyKey: string;
  amountCents?: number;
  noteToPayer?: string;
};

export type ReserveRefundResult =
  | {
      ok: true;
      duplicate: boolean;
      refund: Refund;
      captureId: string;
    }
  | {
      ok: false;
      statusCode: number;
      error: string;
    };

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    return value as JsonObject;
  }

  return null;
}

function getString(
  object: JsonObject | null,
  key: string
): string | undefined {
  const value = object?.[key];
  return typeof value === "string" ? value : undefined;
}

function getRefundCaptureId(
  resource: JsonObject | null
): string | undefined {
  const supplementaryData = asObject(
    resource?.supplementary_data
  );

  const relatedIds = asObject(
    supplementaryData?.related_ids
  );

  const relatedCaptureId = getString(
    relatedIds,
    "capture_id"
  );

  if (relatedCaptureId) {
    return relatedCaptureId;
  }

  const links = Array.isArray(resource?.links)
    ? resource.links
    : [];

  for (const candidate of links) {
    const link = asObject(candidate);

    if (getString(link, "rel") !== "up") {
      continue;
    }

    const href = getString(link, "href");
    const match = href?.match(/\/captures\/([^/?#]+)/i);

    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

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

// SHARED NET DONATION ACCOUNTING
// ==========================================

type DonationNetAmountInput = {
  id: string;
  amountCents: number;
  status: string;
  paypalCaptureId: string | null;
  currencyCode: string;
};

/**
 * Returns each donation's net contribution after completed refunds.
 *
 * Includes:
 * - Completed records in the Refund table.
 * - Historical P3 refund webhook events.
 * - Deduplication using PayPal refund IDs and internal custom IDs.
 *
 * Fetches refunds and webhook events in batches.
 */
export async function getNetDonationAmountsCents(
  tx: Pick<
    Prisma.TransactionClient,
    "refund" | "webhookEvent"
  >,
  donations: DonationNetAmountInput[]
): Promise<Map<string, number>> {
  const netAmounts = new Map<string, number>();

  if (donations.length === 0) {
    return netAmounts;
  }

  const donationIds = donations.map(
    (donation) => donation.id
  );

  const [refundRows, webhookEvents] = await Promise.all([
    tx.refund.findMany({
      where: {
        donationId: {
          in: donationIds,
        },
      },
      select: {
        id: true,
        donationId: true,
        paypalRefundId: true,
        amountCents: true,
        status: true,
      },
    }),

    tx.webhookEvent.findMany({
      where: {
        eventType: "PAYMENT.CAPTURE.REFUNDED",
      },
      select: {
        resourceId: true,
        payload: true,
      },
    }),
  ]);

  const completedRefundsByDonation = new Map<string, number>();

  const paypalRefundIds = new Set<string>();
  const internalRefundIds = new Set<string>();

  for (const refund of refundRows) {
    internalRefundIds.add(refund.id);

    if (refund.paypalRefundId) {
      paypalRefundIds.add(refund.paypalRefundId);
    }

    if (refund.status === "completed") {
      const previous =
        completedRefundsByDonation.get(refund.donationId) ?? 0;

      completedRefundsByDonation.set(
        refund.donationId,
        previous + refund.amountCents
      );
    }
  }

  const donationsByCaptureId = new Map(
    donations
      .filter(
        (donation): donation is DonationNetAmountInput & {
          paypalCaptureId: string;
        } => Boolean(donation.paypalCaptureId)
      )
      .map((donation) => [
        donation.paypalCaptureId,
        donation,
      ])
  );

  const countedLegacyRefundIds = new Set<string>();

  for (const event of webhookEvents) {
    const payload = asObject(event.payload);
    const resource = asObject(payload?.resource);

    const refundId =
      getString(resource, "id") ?? event.resourceId;

    const customId = getString(resource, "custom_id");

    if (
      !refundId ||
      countedLegacyRefundIds.has(refundId) ||
      paypalRefundIds.has(refundId) ||
      (customId && internalRefundIds.has(customId))
    ) {
      continue;
    }

    const refundStatus = getString(resource, "status");

    // Preserve existing P3 behaviour.
    // Missing status is accepted; explicit non-completed
    // statuses are not counted.
    if (refundStatus && refundStatus !== "COMPLETED") {
      continue;
    }

    const captureId = getRefundCaptureId(resource);
    const donation = captureId
      ? donationsByCaptureId.get(captureId)
      : undefined;

    if (!donation) {
      continue;
    }

    const money = asObject(resource?.amount);
    const currencyCode = getString(
      money,
      "currency_code"
    );

    if (currencyCode !== donation.currencyCode) {
      continue;
    }

    const refundAmountCents = amountToCents(
      resource?.amount
    );

    if (
      refundAmountCents === null ||
      refundAmountCents <= 0
    ) {
      continue;
    }

    countedLegacyRefundIds.add(refundId);

    const previous =
      completedRefundsByDonation.get(donation.id) ?? 0;

    completedRefundsByDonation.set(
      donation.id,
      previous + refundAmountCents
    );
  }

  for (const donation of donations) {
    const refundedCents = Math.min(
      donation.amountCents,
      completedRefundsByDonation.get(donation.id) ?? 0
    );

    const netAmount =
      donation.status === "completed"
        ? donation.amountCents - refundedCents
        : 0;

    netAmounts.set(donation.id, netAmount);
  }

  return netAmounts;
}

// ==========================================
// RESERVE REFUND REQUEST
// ==========================================

export async function reserveRefundRequest(
  input: ReserveRefundInput
): Promise<ReserveRefundResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  const noteToPayer = input.noteToPayer?.trim() || null;

  if (!idempotencyKey || idempotencyKey.length > 128) {
    return {
      ok: false,
      statusCode: 400,
      error: "Idempotency key must contain 1 to 128 characters",
    };
  }

  if (
    input.amountCents !== undefined &&
    (!Number.isSafeInteger(input.amountCents) ||
      input.amountCents <= 0)
  ) {
    return {
      ok: false,
      statusCode: 400,
      error: "Refund amount must be positive integer cents",
    };
  }

  if (
    input.noteToPayer !== undefined &&
    (!noteToPayer || noteToPayer.length > 255)
  ) {
    return {
      ok: false,
      statusCode: 400,
      error: "Refund note must contain 1 to 255 characters",
    };
  }

  return prisma.$transaction(
    async (tx) => {
      // Serialize refund reservations for this donation.
      const lockedRows = await tx.$queryRaw<
        Array<{ id: string }>
      >`
        SELECT "id"
        FROM "Donation"
        WHERE "id" = ${input.donationId}::uuid
        FOR UPDATE
      `;

      if (lockedRows.length === 0) {
        return {
          ok: false,
          statusCode: 404,
          error: "Donation not found",
        };
      }

      const donation = await tx.donation.findUnique({
        where: {
          id: input.donationId,
        },
        include: {
          campaign: {
            select: {
              currency: true,
            },
          },
        },
      });

      if (!donation) {
        return {
          ok: false,
          statusCode: 404,
          error: "Donation not found",
        };
      }

      if (!donation.paypalCaptureId) {
        return {
          ok: false,
          statusCode: 409,
          error: "Donation has no PayPal capture to refund",
        };
      }

      // Check idempotency before donation status and balance.
      const existing = await tx.refund.findUnique({
        where: {
          donationId_idempotencyKey: {
            donationId: input.donationId,
            idempotencyKey,
          },
        },
      });

      if (existing) {
        if (
          (input.amountCents !== undefined &&
            input.amountCents !== existing.amountCents) ||
          noteToPayer !== existing.noteToPayer
        ) {
          return {
            ok: false,
            statusCode: 409,
            error:
              "Idempotency key was already used with different refund details",
          };
        }

        return {
          ok: true,
          duplicate: true,
          refund: existing,
          captureId: donation.paypalCaptureId,
        };
      }

      if (donation.status !== "completed") {
        return {
          ok: false,
          statusCode: 409,
          error: "Only completed donations can be refunded",
        };
      }

      if (donation.campaign.currency !== "USD") {
        return {
          ok: false,
          statusCode: 409,
          error: "Refunds currently support USD donations only",
        };
      }

      // Only one unresolved refund is allowed per donation.
      const unresolvedRefund = await tx.refund.findFirst({
        where: {
          donationId: input.donationId,
          status: {
            in: [
              "processing",
              "pending",
              "reconciliation_required",
            ],
          },
        },
      });

      if (unresolvedRefund) {
        return {
          ok: false,
          statusCode: 409,
          error:
            "Another refund is still being processed or reconciled",
        };
      }

      const netAmounts = await getNetDonationAmountsCents(
        tx,
        [
          {
            id: donation.id,
            amountCents: donation.amountCents,
            status: donation.status,
            paypalCaptureId: donation.paypalCaptureId,
            currencyCode: donation.campaign.currency,
          },
        ]
      );

      const remainingCents =
        netAmounts.get(donation.id) ?? 0;

      if (remainingCents <= 0) {
        return {
          ok: false,
          statusCode: 409,
          error: "Donation has no remaining refundable balance",
        };
      }

      // Omitted amount means refund the remaining balance.
      const refundAmountCents =
        input.amountCents ?? remainingCents;

      if (refundAmountCents > remainingCents) {
        return {
          ok: false,
          statusCode: 409,
          error:
            "Refund exceeds the remaining refundable balance",
        };
      }

      const refund = await tx.refund.create({
        data: {
          donationId: input.donationId,
          idempotencyKey,
          amountCents: refundAmountCents,
          noteToPayer,
          status: "processing",
        },
      });

      // Record the reservation in the ledger atomically.
      await appendEventInTransaction(
        tx,
        "DONATION_REFUND_REQUESTED",
        refund.id,
        {
          donationId: donation.id,
          paypalCaptureId: donation.paypalCaptureId,
          amountCents: refundAmountCents,
          currencyCode: donation.campaign.currency,
          source: "api",
        }
      );

      return {
        ok: true,
        duplicate: false,
        refund,
        captureId: donation.paypalCaptureId,
      };
    },
    {
      maxWait: 10000,
      timeout: 35000,
    }
  );
}

// ==========================================
// PAYPAL RESPONSE UPDATES
// ==========================================

type PayPalRefundResult = {
  refundId?: string;
  status: string;
};

// Update a refund using an existing transaction.
// This can safely be called by both API routes and webhooks.
export async function updateRefundFromPayPalResponseInTransaction(
  tx: Prisma.TransactionClient,
  refundId: string,
  result: PayPalRefundResult,
  failureReason?: string
) {
  // Lock the refund row to prevent a delayed API response
  // from overwriting a concurrent webhook confirmation.
  await tx.$queryRaw`
    SELECT "id"
    FROM "Refund"
    WHERE "id" = ${refundId}::uuid
    FOR UPDATE
  `;

  const refund = await tx.refund.findUnique({
    where: {
      id: refundId,
    },
  });

  if (!refund) {
    throw new Error("Refund record not found.");
  }

  const paypalRefundId = result.refundId?.trim() || null;

  if (
    paypalRefundId &&
    refund.paypalRefundId &&
    refund.paypalRefundId !== paypalRefundId
  ) {
    throw new Error(
      "Refund is already associated with a different PayPal refund ID."
    );
  }

  let nextStatus: Refund["status"];

  switch (result.status) {
    case "COMPLETED":
      nextStatus = "completed";
      break;

    case "PENDING":
      nextStatus = "pending";
      break;

    case "FAILED":
      nextStatus = "failed";
      break;

    case "CANCELLED":
      nextStatus = "cancelled";
      break;

    default:
      nextStatus = "reconciliation_required";
  }

  // Completed is authoritative and must never be downgraded.
  if (refund.status === "completed") {
    nextStatus = "completed";
  }

  // Preserve confirmed failures and cancellations unless
  // PayPal subsequently confirms completion.
  if (
    (refund.status === "failed" ||
      refund.status === "cancelled") &&
    nextStatus !== "completed"
  ) {
    nextStatus = refund.status;
  }

  const statusChanged = refund.status !== nextStatus;

  const idChanged =
    Boolean(paypalRefundId) &&
    refund.paypalRefundId !== paypalRefundId;

  if (!statusChanged && !idChanged && !failureReason) {
    return refund;
  }

  const updated = await tx.refund.update({
    where: {
      id: refundId,
    },
    data: {
      ...(paypalRefundId
        ? { paypalRefundId }
        : {}),
      status: nextStatus,
      completedAt:
        nextStatus === "completed"
          ? refund.completedAt ?? new Date()
          : refund.completedAt,
      failureReason:
        nextStatus === "reconciliation_required" ||
        nextStatus === "failed"
          ? failureReason?.slice(0, 1000) ??
            refund.failureReason
          : null,
    },
  });

  if (statusChanged || idChanged) {
    await appendEventInTransaction(
      tx,
      `DONATION_REFUND_${nextStatus.toUpperCase()}`,
      refund.id,
      {
        donationId: refund.donationId,
        paypalRefundId: updated.paypalRefundId,
        amountCents: refund.amountCents,
        previousStatus: refund.status,
        newStatus: nextStatus,
      }
    );
  }

  return updated;
}

// API-facing wrapper. It starts its own transaction.
export async function updateRefundFromPayPalResponse(
  refundId: string,
  result: PayPalRefundResult,
  failureReason?: string
) {
  return prisma.$transaction(
    (tx) =>
      updateRefundFromPayPalResponseInTransaction(
        tx,
        refundId,
        result,
        failureReason
      ),
    {
      maxWait: 10000,
      timeout: 35000,
    }
  );
}

// ==========================================
// REFUND WEBHOOK MATCHING
// ==========================================

// Match by PayPal refund ID when the API response was saved first.
// Match by our internal UUID in custom_id when the webhook arrives
// before the API response. Never guess using donation + amount alone.
export async function completeRefundFromWebhookInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    donationId: string;
    paypalRefundId: string;
    customId?: string;
    amountCents: number;
  }
): Promise<{
  matched: boolean;
  refund: Refund | null;
}> {
  const paypalMatch = await tx.refund.findUnique({
    where: {
      paypalRefundId: input.paypalRefundId,
    },
  });

  const isInternalRefundId =
    typeof input.customId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.customId
    );

  const customIdMatch = isInternalRefundId
    ? await tx.refund.findUnique({
        where: {
          id: input.customId!,
        },
      })
    : null;

  // Both PayPal identifiers must refer to the same record.
  if (
    paypalMatch &&
    customIdMatch &&
    paypalMatch.id !== customIdMatch.id
  ) {
    throw new Error(
      "PayPal refund ID and custom ID identify different refund records."
    );
  }

  const refund = paypalMatch ?? customIdMatch;

  // Historical or externally initiated refunds may have
  // no matching internal Refund record. Do not guess.
  if (!refund) {
    return {
      matched: false,
      refund: null,
    };
  }

  if (
    refund.donationId !== input.donationId ||
    refund.amountCents !== input.amountCents
  ) {
    throw new Error(
      "PayPal refund does not match the reserved donation or amount."
    );
  }

  if (
    isInternalRefundId &&
    refund.id !== input.customId
  ) {
    throw new Error(
      "PayPal custom ID does not match the refund record."
    );
  }

  // Lock and reread to prevent concurrent API/webhook updates.
  await tx.$queryRaw`
    SELECT "id"
    FROM "Refund"
    WHERE "id" = ${refund.id}::uuid
    FOR UPDATE
  `;

  const currentRefund = await tx.refund.findUnique({
    where: {
      id: refund.id,
    },
  });

  if (!currentRefund) {
    throw new Error("Refund reservation disappeared.");
  }

  if (
    currentRefund.donationId !== input.donationId ||
    currentRefund.amountCents !== input.amountCents ||
    (currentRefund.paypalRefundId &&
      currentRefund.paypalRefundId !== input.paypalRefundId)
  ) {
    throw new Error(
      "Refund reservation changed while processing the webhook."
    );
  }

  const statusChanged =
    currentRefund.status !== "completed";

  const idChanged =
    currentRefund.paypalRefundId !== input.paypalRefundId;

  if (!statusChanged && !idChanged) {
    return {
      matched: true,
      refund: currentRefund,
    };
  }

  const updated = await tx.refund.update({
    where: {
      id: currentRefund.id,
    },
    data: {
      paypalRefundId: input.paypalRefundId,
      status: "completed",
      completedAt:
        currentRefund.completedAt ?? new Date(),
      failureReason: null,
    },
  });

  await appendEventInTransaction(
    tx,
    "DONATION_REFUND_COMPLETED",
    updated.id,
    {
      donationId: updated.donationId,
      paypalRefundId: input.paypalRefundId,
      amountCents: updated.amountCents,
      previousStatus: currentRefund.status,
      newStatus: "completed",
      source: "paypal_webhook",
    }
  );

  return {
    matched: true,
    refund: updated,
  };
}