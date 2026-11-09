
import { Prisma } from "@prisma/client";

import { appendEventInTransaction } from "./ledger.service";

// ==========================================
// TYPES AND HELPERS
// ==========================================

type PayoutWebhookResult = {
  payoutId: string;
  milestoneId: string;
  organizationId?: string;
  action: "batch_completed" | "item_succeeded";
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

  const payout = await tx.payout.findUnique({
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

  // ------------------------------------------
  // PAYOUT BATCH SUCCESS
  // ------------------------------------------

  if (
    eventType === "PAYMENT.PAYOUTSBATCH.SUCCESS"
  ) {
    // Batch success confirms submission/processing,
    // but does NOT prove individual funds were delivered.
    //
    // An already-paid payout must never be downgraded.
    if (currentPayout.status !== "paid") {
      await tx.payout.update({
        where: { id: currentPayout.id },
        data: {
          status: "processing",
          submittedAt:
            currentPayout.submittedAt ?? new Date(),
        },
      });
    }

    const existingBatchEvent =
      await tx.ledgerEvent.findFirst({
        where: {
          entityId: currentPayout.id,
          type: "PAYOUT_BATCH_COMPLETED",
        },
        select: { id: true },
      });

    if (!existingBatchEvent) {
      await appendEventInTransaction(
        tx,
        "PAYOUT_BATCH_COMPLETED",
        currentPayout.id,
        {
          paypalBatchId: batchId,
          source: "paypal_webhook",
        }
      );
    }

    return {
      payoutId: currentPayout.id,
      milestoneId: currentPayout.milestoneId,
      action: "batch_completed",
    };
  }

  // ------------------------------------------
  // INDIVIDUAL PAYOUT ITEM SUCCESS
  // ------------------------------------------

  if (
    eventType === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED"
  ) {
    const resourceId = getString(resource, "id");

    const payoutItemId =
      getString(resource, "payout_item_id") ?? resourceId;

    const transactionId =
      getString(resource, "transaction_id");

    // Individual item success is the confirmation
    // that completes the payout.
    if (currentPayout.status !== "paid") {
      await tx.payout.update({
        where: { id: currentPayout.id },
        data: {
          status: "paid",
          submittedAt:
            currentPayout.submittedAt ?? new Date(),
        },
      });
    }

    // Record success exactly once.
    const existingSuccessEvent =
      await tx.ledgerEvent.findFirst({
        where: {
          entityId: currentPayout.id,
          type: "PAYOUT_ITEM_SUCCEEDED",
        },
        select: { id: true },
      });

    if (!existingSuccessEvent) {
      await appendEventInTransaction(
        tx,
        "PAYOUT_ITEM_SUCCEEDED",
        currentPayout.id,
        {
          paypalBatchId: batchId,
          paypalPayoutItemId: payoutItemId ?? null,
          transactionId: transactionId ?? null,
          source: "paypal_webhook",
        }
      );
    }

    // Only individual item success completes the milestone.
    if (payout.milestone.status !== "paid") {
      await tx.milestone.update({
        where: { id: currentPayout.milestoneId },
        data: { status: "paid" },
      });
    }

    return {
      payoutId: currentPayout.id,
      milestoneId: currentPayout.milestoneId,
      organizationId:
        payout.milestone.campaign.organizationId,
      action: "item_succeeded",
    };
  }

  throw new Error(
    `Unsupported payout webhook event: ${eventType}`
  );
}
