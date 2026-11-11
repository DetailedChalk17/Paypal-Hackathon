
import { Prisma } from "@prisma/client";

import { appendEventInTransaction } from "./ledger.service";

// ==========================================
// TYPES AND HELPERS
// ==========================================

type PayoutWebhookResult = {
  payoutId: string;
  milestoneId: string;
  organizationId?: string;
  action:
    | "batch_completed"
    | "batch_processing"
    | "batch_denied"
    | "item_succeeded"
    | "item_failed"
    | "item_requires_reconciliation";
};

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

function getPayoutBatchId(
  resource: Record<string, unknown> | null
): string | undefined {
  const batchHeader = asObject(resource?.batch_header);
  const payoutBatchHeader = asObject(
    resource?.payout_batch_header
  );

  const supplementaryData = asObject(
    resource?.supplementary_data
  );

  const relatedIds = asObject(
    supplementaryData?.related_ids
  );

  return (
    getString(batchHeader, "payout_batch_id") ??
    getString(payoutBatchHeader, "payout_batch_id") ??
    getString(resource, "payout_batch_id") ??
    getString(relatedIds, "payout_batch_id")
  );
}

function getSenderBatchId(
  resource: Record<string, unknown> | null
): string | undefined {
  const batchHeader = asObject(resource?.batch_header);
  const payoutBatchHeader = asObject(
    resource?.payout_batch_header
  );

  const senderBatchHeader = asObject(
    resource?.sender_batch_header
  );

  const nestedBatchSenderHeader = asObject(
    batchHeader?.sender_batch_header
  );

  const nestedPayoutBatchSenderHeader = asObject(
    payoutBatchHeader?.sender_batch_header
  );

  return (
    getString(resource, "sender_batch_id") ??
    getString(senderBatchHeader, "sender_batch_id") ??
    getString(nestedBatchSenderHeader, "sender_batch_id") ??
    getString(nestedPayoutBatchSenderHeader, "sender_batch_id")
  );
}

// ==========================================
// PROCESS PAYOUT WEBHOOK
// ==========================================

export async function processPayoutWebhookEvent(
  tx: Prisma.TransactionClient,
  eventType: string,
  resource: Record<string, unknown> | null
): Promise<PayoutWebhookResult> {
  const batchId = getPayoutBatchId(resource);

  if (!batchId) {
    throw new Error(
      "Payout webhook event is missing its batch ID"
    );
  }

    const senderBatchId = getSenderBatchId(resource);

  const include = {
    milestone: {
      include: {
        campaign: {
          select: {
            organizationId: true,
          },
        },
      },
    },
  } satisfies Prisma.PayoutInclude;

  const payoutByBatchId = await tx.payout.findUnique({
    where: { paypalBatchId: batchId },
    include,
  });

  const payoutBySenderBatchId = senderBatchId
    ? await tx.payout.findUnique({
        where: { senderBatchId },
        include,
      })
    : null;

  // If the two identifiers resolve to different payouts,
  // never guess which payout this webhook belongs to.
  if (
    payoutByBatchId &&
    payoutBySenderBatchId &&
    payoutByBatchId.id !== payoutBySenderBatchId.id
  ) {
    throw new Error(
      "PayPal batch ID and sender batch ID resolve to different payouts"
    );
  }

  const payout = payoutByBatchId ?? payoutBySenderBatchId;

  if (!payout) {
    throw new Error(
      senderBatchId
        ? `No payout found for PayPal batch ${batchId} or sender batch ${senderBatchId}`
        : `No payout found for PayPal batch ${batchId}`
    );
  }

  // Serialize updates for this payout.
  // Prevents concurrent webhooks from creating duplicate ledger events.
  await tx.$queryRaw`
    SELECT "id"
    FROM "Payout"
    WHERE "id" = ${payout.id}::uuid
    FOR UPDATE
  `;

  const currentPayout = await tx.payout.findUnique({
    where: { id: payout.id },
  });

  if (!currentPayout) {
    throw new Error(
      "Payout record disappeared during processing"
    );
  }
  // A webhook may arrive before releasePayout() persists
  // the PayPal API response. Associate the provider batch ID
  // using the already-persisted sender batch ID.
  if (
    currentPayout.paypalBatchId &&
    currentPayout.paypalBatchId !== batchId
  ) {
    throw new Error(
      "Payout is already associated with a different PayPal batch ID"
    );
  }

  if (!currentPayout.paypalBatchId) {
    const association = await tx.payout.updateMany({
      where: {
        id: currentPayout.id,
        paypalBatchId: null,
      },
      data: {
        paypalBatchId: batchId,
      },
    });

    if (association.count === 0) {
      const latestPayout = await tx.payout.findUnique({
        where: { id: currentPayout.id },
        select: { paypalBatchId: true },
      });

      if (latestPayout?.paypalBatchId !== batchId) {
        throw new Error(
          "Could not safely associate PayPal batch ID with payout"
        );
      }
    }
  }

  // ------------------------------------------
  // MAP PAYPAL EVENT TO INTERNAL PAYOUT STATE
  // ------------------------------------------

  let nextStatus:
    | "processing"
    | "paid"
    | "failed"
    | "reconciliation_required";

  let ledgerEventType: string;
  let action: PayoutWebhookResult["action"];

  switch (eventType) {
    case "PAYMENT.PAYOUTSBATCH.SUCCESS":
      nextStatus = "processing";
      ledgerEventType = "PAYOUT_BATCH_COMPLETED";
      action = "batch_completed";
      break;

    case "PAYMENT.PAYOUTSBATCH.PROCESSING":
      nextStatus = "processing";
      ledgerEventType = "PAYOUT_BATCH_PROCESSING";
      action = "batch_processing";
      break;

    case "PAYMENT.PAYOUTSBATCH.DENIED":
      nextStatus = "reconciliation_required";
      ledgerEventType = "PAYOUT_BATCH_DENIED";
      action = "batch_denied";
      break;

    case "PAYMENT.PAYOUTS-ITEM.SUCCEEDED":
      nextStatus = "paid";
      ledgerEventType = "PAYOUT_ITEM_SUCCEEDED";
      action = "item_succeeded";
      break;

    case "PAYMENT.PAYOUTS-ITEM.FAILED":
      nextStatus = "failed";
      ledgerEventType = "PAYOUT_ITEM_FAILED";
      action = "item_failed";
      break;

    case "PAYMENT.PAYOUTS-ITEM.BLOCKED":
    case "PAYMENT.PAYOUTS-ITEM.HELD":
    case "PAYMENT.PAYOUTS-ITEM.CANCELED":
    case "PAYMENT.PAYOUTS-ITEM.REFUNDED":
    case "PAYMENT.PAYOUTS-ITEM.RETURNED":
    case "PAYMENT.PAYOUTS-ITEM.UNCLAIMED":
      nextStatus = "reconciliation_required";
      ledgerEventType = "PAYOUT_ITEM_REQUIRES_RECONCILIATION";
      action = "item_requires_reconciliation";
      break;

    default:
      throw new Error(
        `Unsupported payout webhook event: ${eventType}`
      );
  }

  // ------------------------------------------
  // EXTRACT ITEM-LEVEL DETAILS
  // ------------------------------------------

  const resourceId = getString(resource, "id");

  const payoutItemId =
    getString(resource, "payout_item_id") ?? resourceId;

  const transactionId = getString(resource, "transaction_id");

  // ------------------------------------------
  // UPDATE PAYOUT STATUS SAFELY
  // ------------------------------------------

  // A confirmed payment must never be downgraded.
  if (currentPayout.status !== "paid") {
    const isBatchEvent =
      eventType === "PAYMENT.PAYOUTSBATCH.SUCCESS" ||
      eventType === "PAYMENT.PAYOUTSBATCH.PROCESSING" ||
      eventType === "PAYMENT.PAYOUTSBATCH.DENIED";

    const isItemSuccess = action === "item_succeeded";

    const preserveExistingState =
      currentPayout.status === "reconciliation_required" &&
      !isItemSuccess;

    const preserveFailureAgainstBatch =
      currentPayout.status === "failed" &&
      isBatchEvent;

    if (
      !preserveExistingState &&
      !preserveFailureAgainstBatch
    ) {
      await tx.payout.update({
        where: { id: currentPayout.id },
        data: {
          status: nextStatus,
          submittedAt:
            currentPayout.submittedAt ?? new Date(),
        },
      });
    }
  }

  // ------------------------------------------
  // UPDATE MILESTONE ONLY ON ITEM SUCCESS
  // ------------------------------------------

  if (
    action === "item_succeeded" &&
    payout.milestone.status !== "paid"
  ) {
    await tx.milestone.update({
      where: { id: currentPayout.milestoneId },
      data: { status: "paid" },
    });
  }

  // ------------------------------------------
  // APPEND AUDIT EVENT EXACTLY ONCE
  // ------------------------------------------

  const existingLedgerEvent =
    await tx.ledgerEvent.findFirst({
      where: {
        entityId: currentPayout.id,
        type: ledgerEventType,
      },
      select: { id: true },
    });

  if (!existingLedgerEvent) {
    await appendEventInTransaction(
      tx,
      ledgerEventType,
      currentPayout.id,
      {
        paypalBatchId: batchId,
        senderBatchId: senderBatchId ?? null,
        paypalPayoutItemId: payoutItemId ?? null,
        transactionId: transactionId ?? null,
        eventType,
        source: "paypal_webhook",
      }
    );
  }

  return {
    payoutId: currentPayout.id,
    milestoneId: currentPayout.milestoneId,
    ...(action === "item_succeeded"
      ? {
          organizationId:
            payout.milestone.campaign.organizationId,
        }
      : {}),
    action,
  };
}
