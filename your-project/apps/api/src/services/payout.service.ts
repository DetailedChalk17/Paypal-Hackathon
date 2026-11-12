
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

import { prisma } from "../lib/prisma";
import { appendEventInTransaction } from "./ledger.service";

// ==========================================
// PAYOUT TYPES
// ==========================================

export type PayoutSubmissionResult = {
  success: boolean;
  senderBatchId: string;
  paypalBatchId?: string;
  message: string;

  // Only an explicit definitive rejection is retryable.
  // Unclassified failures are treated as uncertain.
  failureKind?: "definitive" | "unknown";
};

export const DEFAULT_STALE_PAYOUT_MINUTES = 15;

// ==========================================
// IDEMPOTENCY
// ==========================================

// Generate the same sender batch ID for every attempt
// involving the same milestone.
function generateSenderBatchId(milestoneId: string): string {
  const hash = createHash("sha256")
    .update(milestoneId)
    .digest("hex")
    .slice(0, 28);

  return `p_${hash}`;
}

// ==========================================
// MOCK PAYPAL PAYOUT
// ==========================================

// Payouts API. This simulates submission, NOT actual payment.
export async function sendMockPayout(input: {
  milestoneId: string;
  amountCents: number;
}): Promise<PayoutSubmissionResult> {
  return {
    success: true,
    senderBatchId: generateSenderBatchId(input.milestoneId),
    message: "Mock payout submitted successfully",
  };
}


// ==========================================
// REAL PAYPAL PAYOUT ADAPTER
// ==========================================

type PayoutSenderInput = {
  milestoneId: string;
  amountCents: number;
  senderBatchId: string;
  recipientEmail: string;
};

// Generate a stable item ID for each milestone.
// The ID must remain unchanged across retries.
function generateSenderItemId(milestoneId: string): string {
  const hash = createHash("sha256")
    .update(milestoneId)
    .digest("hex")
    .slice(0, 28);

  return `i_${hash}`;
}


export async function sendPayPalPayout(
  input: PayoutSenderInput
): Promise<PayoutSubmissionResult> {
  // Load the PayPal package before entering the try/catch.
  // This keeps its error classes accessible inside catch.
  const paypal = await import("@your-project/paypal");

  try {
    const result = await paypal.createPayout({
      receiverEmail: input.recipientEmail,
      amountCents: input.amountCents,
      senderBatchId: input.senderBatchId,
      senderItemId: generateSenderItemId(input.milestoneId),
    });

    return {
      success: true,
      senderBatchId: result.senderBatchId,
      paypalBatchId: result.payoutBatchId,
      message: `PayPal payout batch submitted with status: ${result.status}`,
    };
  } catch (error: unknown) {
    const definitivePreSubmissionFailure =
      error instanceof paypal.PayPalConfigurationError ||
      error instanceof paypal.PayPalAuthenticationError ||
      (
        error instanceof paypal.PayPalTransportError &&
        error.stage === "authentication"
      );

    return {
      success: false,
      senderBatchId: input.senderBatchId,
      message: error instanceof Error
        ? error.message
        : "Unknown PayPal payout error",
      failureKind: definitivePreSubmissionFailure
        ? "definitive"
        : "unknown",
    };
  }
}


// ==========================================
// OUTCOME HELPERS
// ==========================================

async function markOutcomeUnknown(
  payoutId: string,
  milestoneId: string,
  senderBatchId: string,
  reason: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.payout.findUnique({
      where: { id: payoutId },
    });

    if (!current || current.status !== "processing") {
      // Never overwrite a webhook-confirmed paid state.
      return;
    }

    // If provider acceptance is already known, preserve the state.
    if (current.submittedAt || current.paypalBatchId) {
      return;
    }

    const changed = await tx.payout.updateMany({
      where: {
        id: payoutId,
        status: "processing",
        submittedAt: null,
        paypalBatchId: null,
      },
      data: {
        status: "reconciliation_required",
      },
    });

    if (changed.count === 0) {
      return;
    }

    await appendEventInTransaction(
      tx,
      "PAYOUT_OUTCOME_UNKNOWN",
      payoutId,
      {
        milestoneId,
        senderBatchId,
        reason,
        source: "payout_service",
      }
    );
  });
}

async function markDefinitiveFailure(
  payoutId: string,
  milestoneId: string,
  senderBatchId: string,
  reason: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.payout.findUnique({
      where: { id: payoutId },
    });

    if (!current) {
      throw new Error("Payout record not found");
    }

    // Do not downgrade a payout already confirmed by PayPal.
    if (
      current.status === "paid" ||
      current.submittedAt ||
      current.paypalBatchId
    ) {
      return;
    }

    if (
      current.status !== "processing" &&
      current.status !== "reconciliation_required"
    ) {
      return;
    }

    const changed = await tx.payout.updateMany({
      where: {
        id: payoutId,
        status: current.status,
        submittedAt: null,
        paypalBatchId: null,
      },
      data: {
        status: "failed",
      },
    });

    if (changed.count === 0) {
      return;
    }

    await appendEventInTransaction(
      tx,
      "PAYOUT_FAILED",
      payoutId,
      {
        milestoneId,
        senderBatchId,
        reason,
        failureKind: "definitive",
        source: "payout_service",
      }
    );
  });
}

// ==========================================
// STALE PAYOUT RECONCILIATION
// ==========================================

/**
 * Marks processing payouts as reconciliation_required when
 * their submission attempt is stale and no provider acceptance
 * has been recorded.
 *
 * This function NEVER resubmits money.
 *
 * It is intended to be called by an operator or scheduled
 * reconciliation job. It does not start its own timer.
 */
export async function markStalePayoutsForReconciliation(
  staleAfterMinutes = DEFAULT_STALE_PAYOUT_MINUTES
): Promise<string[]> {
  if (
    !Number.isSafeInteger(staleAfterMinutes) ||
    staleAfterMinutes <= 0
  ) {
    throw new Error(
      "Stale payout threshold must be a positive integer"
    );
  }

  const staleBefore = new Date(
    Date.now() - staleAfterMinutes * 60 * 1000
  );

  return prisma.$transaction(
    async (tx) => {
      const candidates = await tx.payout.findMany({
        where: {
          status: "processing",
          submittedAt: null,
          submissionAttemptStartedAt: {
            lt: staleBefore,
          },
        },
        select: {
          id: true,
          milestoneId: true,
          senderBatchId: true,
          submissionAttemptStartedAt: true,
        },
      });

      const markedIds: string[] = [];

      for (const candidate of candidates) {
        // Recheck the original conditions atomically.
        const changed = await tx.payout.updateMany({
          where: {
            id: candidate.id,
            status: "processing",
            submittedAt: null,
            submissionAttemptStartedAt: {
              lt: staleBefore,
            },
          },
          data: {
            status: "reconciliation_required",
          },
        });

        if (changed.count === 0) {
          continue;
        }

        await appendEventInTransaction(
          tx,
          "PAYOUT_RECONCILIATION_REQUIRED",
          candidate.id,
          {
            milestoneId: candidate.milestoneId,
            senderBatchId: candidate.senderBatchId,
            submissionAttemptStartedAt:
              candidate.submissionAttemptStartedAt?.toISOString() ?? null,
            staleAfterMinutes,
            source: "stale_payout_detection",
          }
        );

        markedIds.push(candidate.id);
      }

      return markedIds;
    },
    {
      maxWait: 10000,
      timeout: 35000,
    }
  );
}

// ==========================================
// RELEASE PAYOUT
// ==========================================

export async function releasePayout(
  milestoneId: string,
  payoutSender: typeof sendPayPalPayout = sendPayPalPayout
) {
  // 1. Fetch milestone and recipient organization.
  const milestone = await prisma.milestone.findUnique({
    where: { id: milestoneId },
    include: {
      campaign: {
        include: {
          organization: {
            select: {
              id: true,
              payoutEmail: true,
            },
          },
        },
      },
    },
  });

  if (!milestone) {
    throw new Error("Milestone not found");
  }

  // 2. Look for an existing payout.
  let payout = await prisma.payout.findUnique({
    where: { milestoneId },
  });

  // These states must never initiate another submission.
  if (
    payout &&
    (
      payout.status === "processing" ||
      payout.status === "paid" ||
      payout.status === "reconciliation_required"
    )
  ) {
    return payout;
  }

  // A provider batch ID or submitted timestamp is evidence
  // of provider acceptance. Never automatically retry it.
  if (
    payout &&
    (payout.submittedAt || payout.paypalBatchId)
  ) {
    await prisma.$transaction(async (tx) => {
      const changed = await tx.payout.updateMany({
        where: {
          id: payout!.id,
          status: "failed",
        },
        data: {
          status: "reconciliation_required",
        },
      });

      if (changed.count > 0) {
        await appendEventInTransaction(
          tx,
          "PAYOUT_RECONCILIATION_REQUIRED",
          payout!.id,
          {
            milestoneId,
            senderBatchId: payout!.senderBatchId,
            paypalBatchId: payout!.paypalBatchId,
            reason:
              "Previously recorded provider submission evidence prevents automatic retry",
            source: "payout_service",
          }
        );
      }
    });

    return prisma.payout.findUniqueOrThrow({
      where: { id: payout.id },
    });
  }

  // 3. Only approved milestones can initiate or retry payouts.
  if (milestone.status !== "approved") {
    throw new Error(
      "Milestone must be approved before payout"
    );
  }
  if (milestone.campaign.currency !== "USD") {
    throw new Error(
      "PayPal payouts currently support USD only"
    );
  }

  // 4. Validate recipient.
  const recipientEmail =
    milestone.campaign.organization.payoutEmail?.trim();

  if (!recipientEmail) {
    throw new Error(
      "Organization payout email is not configured"
    );
  }

  // 5. Validate amount.
  const amountCents = milestone.budgetAmountCents;

  if (
    !Number.isSafeInteger(amountCents) ||
    amountCents <= 0
  ) {
    throw new Error("Invalid milestone payout amount");
  }

  // 6. Generate stable batch ID.
  const generatedBatchId = generateSenderBatchId(milestoneId);

  // 7. Create the payout record if it doesn't exist.
  if (!payout) {
    try {
      payout = await prisma.$transaction(async (tx) => {
        const existing = await tx.payout.findUnique({
          where: { milestoneId },
        });

        if (existing) {
          return existing;
        }

        const created = await tx.payout.create({
          data: {
            milestoneId,
            amountCents,
            senderBatchId: generatedBatchId,
            status: "pending",
          },
        });

        await appendEventInTransaction(
          tx,
          "PAYOUT_INITIATED",
          created.id,
          {
            milestoneId,
            campaignId: milestone.campaignId,
            organizationId:
              milestone.campaign.organization.id,
            amountCents,
            currency: milestone.campaign.currency,
            senderBatchId: generatedBatchId,
          }
        );

        return created;
      });
    } catch (error) {
      // Another request may have created the unique payout.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        payout = await prisma.payout.findUnique({
          where: { milestoneId },
        });

        if (!payout) {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  if (!payout) {
    throw new Error("Unable to create or retrieve payout");
  }

  // Recheck states after a concurrent create.
  if (
    payout.status === "processing" ||
    payout.status === "paid" ||
    payout.status === "reconciliation_required"
  ) {
    return payout;
  }

  // 8. Preserve the same batch ID across retries.
  if (!payout.senderBatchId) {
    await prisma.payout.updateMany({
      where: {
        id: payout.id,
        senderBatchId: null,
      },
      data: {
        senderBatchId: generatedBatchId,
      },
    });

    payout = await prisma.payout.findUniqueOrThrow({
      where: { id: payout.id },
    });
  }

  const senderBatchId = payout.senderBatchId;

  if (!senderBatchId) {
    throw new Error("Payout sender batch ID is missing");
  }

  // 9. Atomically claim the payout for submission.
  const claim = await prisma.$transaction(async (tx) => {
    const current = await tx.payout.findUnique({
      where: { id: payout!.id },
    });

    if (!current) {
      throw new Error("Payout record not found");
    }

    if (
      current.status !== "pending" &&
      current.status !== "failed"
    ) {
      return {
        claimed: false,
        payout: current,
      };
    }

    // Provider acceptance evidence always blocks retries.
    if (current.submittedAt || current.paypalBatchId) {
      const changed = await tx.payout.updateMany({
        where: {
          id: current.id,
          status: current.status,
        },
        data: {
          status: "reconciliation_required",
        },
      });

      if (changed.count > 0) {
        await appendEventInTransaction(
          tx,
          "PAYOUT_RECONCILIATION_REQUIRED",
          current.id,
          {
            milestoneId,
            senderBatchId,
            paypalBatchId: current.paypalBatchId,
            reason: "Provider submission evidence exists",
            source: "payout_service",
          }
        );
      }

      return {
        claimed: false,
        payout: await tx.payout.findUniqueOrThrow({
          where: { id: current.id },
        }),
      };
    }

    const updated = await tx.payout.updateMany({
      where: {
        id: current.id,
        status: current.status,
        submittedAt: null,
        paypalBatchId: null,
      },
      data: {
        status: "processing",
        submissionAttemptStartedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      return {
        claimed: false,
        payout: await tx.payout.findUniqueOrThrow({
          where: { id: current.id },
        }),
      };
    }

    // Record retries in the ledger.
    if (current.status === "failed") {
      await appendEventInTransaction(
        tx,
        "PAYOUT_RETRY_STARTED",
        current.id,
        {
          milestoneId,
          senderBatchId,
          amountCents,
          source: "payout_service",
        }
      );
    }

    return {
      claimed: true,
      payout: await tx.payout.findUniqueOrThrow({
        where: { id: current.id },
      }),
    };
  });

  // Another request is already handling this payout.
  if (!claim.claimed) {
    return claim.payout;
  }

  // 10. Submit through the injected payout adapter.
  // Tests can inject controlled success/failure responses.
  try {
    const result = await payoutSender({
      milestoneId,
      amountCents,
      senderBatchId,
      recipientEmail,
    });

    // 11. Handle explicit provider rejection.
    if (!result.success) {
      const reason =
        result.message || "Payout submission failed";

      if (
        result.failureKind === "definitive" &&
        result.senderBatchId === senderBatchId
      ) {
        await markDefinitiveFailure(
          payout.id,
          milestoneId,
          senderBatchId,
          reason
        );

        throw new Error(reason);
      }

      // An unclassified failure or mismatched batch ID is ambiguous.
      await markOutcomeUnknown(
        payout.id,
        milestoneId,
        senderBatchId,
        reason
      );

      throw new Error(
        `Payout submission outcome is unknown; reconciliation required: ${reason}`
      );
    }

    // A success response with the wrong batch ID is not safe to retry.
    if (result.senderBatchId !== senderBatchId) {
      const reason = "Payout sender batch ID does not match";

      await markOutcomeUnknown(
        payout.id,
        milestoneId,
        senderBatchId,
        reason
      );

      throw new Error(
        `${reason}; reconciliation required`
      );
    }
    // 12. Record confirmed submission.
    // Persist provider metadata without overwriting a state
    // already established by a webhook.

    const updatedPayout = await prisma.$transaction(
      async (tx) => {
        // Serialize this update against concurrent webhook updates.
        await tx.$queryRaw`
          SELECT "id"
          FROM "Payout"
          WHERE "id" = ${payout!.id}::uuid
          FOR UPDATE
        `;

        const current = await tx.payout.findUnique({
          where: { id: payout!.id },
        });

        if (!current) {
          throw new Error("Payout record not found");
        }

        // Never associate one local payout with two different
        // PayPal batch IDs.
        if (
          result.paypalBatchId &&
          current.paypalBatchId &&
          current.paypalBatchId !== result.paypalBatchId
        ) {
          throw new Error(
            "PayPal response batch ID conflicts with the existing payout batch ID"
          );
        }

        // Save provider acceptance metadata, but preserve the
        // current status regardless of whether it is processing,
        // paid, failed, or reconciliation_required.
        const updated = await tx.payout.updateMany({
          where: {
            id: current.id,
            status: current.status,
            paypalBatchId: current.paypalBatchId,
          },
          data: {
            submittedAt:
              current.submittedAt ?? new Date(),
            ...(result.paypalBatchId
              ? { paypalBatchId: result.paypalBatchId }
              : {}),
          },
        });

        if (updated.count === 0) {
          throw new Error(
            "Payout changed while recording submission metadata"
          );
        }

        // Record the submission event exactly once.
        const existingSubmissionEvent =
          await tx.ledgerEvent.findFirst({
            where: {
              entityId: payout!.id,
              type: "PAYOUT_BATCH_SUBMITTED",
            },
            select: { id: true },
          });

        if (!existingSubmissionEvent) {
          await appendEventInTransaction(
            tx,
            "PAYOUT_BATCH_SUBMITTED",
            payout!.id,
            {
              milestoneId,
              senderBatchId: result.senderBatchId,
              paypalBatchId:
                result.paypalBatchId ?? null,
              source: "payout_service",
            }
          );
        }

        return tx.payout.findUniqueOrThrow({
          where: { id: payout!.id },
        });
      },
      {
        maxWait: 10000,
        timeout: 35000,
      }
    );

    return updatedPayout;

  } catch (error) {
    // Errors after provider acceptance must not be treated as
    // definitive rejection. Preserve paid or accepted states.
    const current = await prisma.payout.findUnique({
      where: { id: payout.id },
    });

    if (
      current &&
      current.status === "processing" &&
      !current.submittedAt &&
      !current.paypalBatchId
    ) {
      const reason =
        error instanceof Error
          ? error.message
          : "Unknown payout submission error";

      await markOutcomeUnknown(
        payout.id,
        milestoneId,
        senderBatchId,
        reason
      );

      throw new Error(
        `Payout submission outcome is unknown; reconciliation required: ${reason}`
      );
    }

    // Preserve confirmed failure and already-paid states.
    throw error;
  }
}
