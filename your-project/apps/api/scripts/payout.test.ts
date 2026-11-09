
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";

import { prisma } from "../src/lib/prisma";

import {
  releasePayout,
  sendMockPayout,
  markStalePayoutsForReconciliation,
} from "../src/services/payout.service";

import { verifyChain } from "../src/services/ledger.service";

import {
  processPayoutWebhookEvent,
} from "../src/services/payout-webhook.service";

type FixtureOptions = {
  milestoneStatus?: "open" | "approved";
  payoutEmail?: string | null;
  budgetAmountCents?: number;
};

async function createMilestoneFixture(
  options: FixtureOptions = {}
) {
  const suffix = randomUUID();

  const organization = await prisma.organization.create({
    data: {
      name: `P5 Test Organization ${suffix}`,
      cause: "Payout integration testing",
      location: "Local test database",
      payoutEmail:
        options.payoutEmail === undefined
          ? `p5-${suffix}@example.test`
          : options.payoutEmail,
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `P5 Test Campaign ${suffix}`,
      goalAmountCents: 100000,
      currency: "USD",
      status: "active",
    },
  });

  const milestone = await prisma.milestone.create({
    data: {
      campaignId: campaign.id,
      title: `P5 Test Milestone ${suffix}`,
      budgetAmountCents: options.budgetAmountCents ?? 5000,
      status: options.milestoneStatus ?? "approved",
    },
  });

  return { organization, campaign, milestone };
}

// ==========================================
// SAFETY CHECKS
// ==========================================

before(async () => {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (!/(localhost|127\.0\.0\.1):5432/.test(databaseUrl)) {
    throw new Error(
      "SAFETY STOP: P5 tests must use a local PostgreSQL database."
    );
  }

  const databaseInfo = await prisma.$queryRaw<
    Array<{ databaseName: string }>
  >`SELECT current_database() AS "databaseName"`;

  const databaseName = databaseInfo[0]?.databaseName;

  if (databaseName !== "impactledger_p5_test") {
    throw new Error(
      `SAFETY STOP: Expected impactledger_p5_test, connected to ${databaseName}.`
    );
  }

  console.log("Connected to isolated P5 test database.");
});

after(async () => {
  await prisma.$disconnect();
});

// ==========================================
// PAYOUT SERVICE INTEGRATION TESTS
// ==========================================

test("P5 payout service integration and reconciliation safety", async (t) => {
  // ------------------------------------------
  // TEST 1: Unapproved milestone
  // ------------------------------------------

  await t.test(
    "Rejects payout for an unapproved milestone",
    async () => {
      const fixture = await createMilestoneFixture({
        milestoneStatus: "open",
      });

      await assert.rejects(
        releasePayout(fixture.milestone.id),
        /Milestone must be approved before payout/
      );

      const count = await prisma.payout.count({
        where: { milestoneId: fixture.milestone.id },
      });

      assert.equal(count, 0);

      console.log("PASS: Unapproved milestone rejected.");
    }
  );

  // ------------------------------------------
  // TEST 2: Missing payout email
  // ------------------------------------------

  await t.test(
    "Rejects payout when organization has no payout email",
    async () => {
      const fixture = await createMilestoneFixture({
        payoutEmail: null,
      });

      await assert.rejects(
        releasePayout(fixture.milestone.id),
        /Organization payout email is not configured/
      );

      const count = await prisma.payout.count({
        where: { milestoneId: fixture.milestone.id },
      });

      assert.equal(count, 0);

      console.log("PASS: Missing payout email rejected.");
    }
  );

  // ------------------------------------------
  // TEST 3: Successful payout submission
  // ------------------------------------------

  let successfulMilestoneId = "";
  let successfulPayoutId = "";

  await t.test(
    "Creates and submits one valid payout",
    async () => {
      const fixture = await createMilestoneFixture();

      successfulMilestoneId = fixture.milestone.id;

      let capturedInput:
        | Parameters<typeof sendMockPayout>[0]
        | undefined;

      const paypalBatchId = `P5-TEST-${randomUUID()}`;

      const payout = await releasePayout(
        fixture.milestone.id,
        async (input) => {
          capturedInput = input;

          return {
            success: true,
            senderBatchId: input.senderBatchId,
            paypalBatchId,
            message: "Test payout submitted",
          };
        }
      );

      successfulPayoutId = payout.id;

      assert.equal(payout.status, "processing");
      assert.equal(payout.amountCents, 5000);
      assert.equal(payout.paypalBatchId, paypalBatchId);

      assert.ok(payout.submissionAttemptStartedAt);
      assert.ok(payout.submittedAt);

      assert.ok(capturedInput);

      assert.equal(
        capturedInput.recipientEmail,
        fixture.organization.payoutEmail
      );

      const events = await prisma.ledgerEvent.findMany({
        where: { entityId: payout.id },
        select: { type: true },
      });

      const eventTypes = events.map((event) => event.type);

      assert.ok(eventTypes.includes("PAYOUT_INITIATED"));
      assert.ok(eventTypes.includes("PAYOUT_BATCH_SUBMITTED"));

      console.log("PASS: Valid payout created and submitted.");
      console.log("PASS: Submission timestamps recorded.");
    }
  );

  // ------------------------------------------
  // TEST 4: Duplicate submission
  // ------------------------------------------

  await t.test(
    "Does not submit an already processing payout twice",
    async () => {
      let senderCalls = 0;

      const payout = await releasePayout(
        successfulMilestoneId,
        async () => {
          senderCalls++;

          throw new Error(
            "Sender must not be called again"
          );
        }
      );

      assert.equal(payout.id, successfulPayoutId);
      assert.equal(payout.status, "processing");
      assert.equal(senderCalls, 0);

      console.log("PASS: Duplicate submission prevented.");
    }
  );

  // ------------------------------------------
  // TEST 5: Definitive provider rejection
  // ------------------------------------------

  let retryMilestoneId = "";
  let failedPayoutId = "";
  let originalSenderBatchId = "";

  await t.test(
    "Records an explicitly confirmed payout rejection",
    async () => {
      const fixture = await createMilestoneFixture();

      retryMilestoneId = fixture.milestone.id;

      await assert.rejects(
        releasePayout(
          fixture.milestone.id,
          async (input) => ({
            success: false,
            senderBatchId: input.senderBatchId,
            failureKind: "definitive",
            message: "Simulated confirmed rejection",
          })
        ),
        /Simulated confirmed rejection/
      );

      const payout = await prisma.payout.findUnique({
        where: { milestoneId: fixture.milestone.id },
      });

      assert.ok(payout);
      assert.equal(payout.status, "failed");
      assert.ok(payout.submissionAttemptStartedAt);
      assert.equal(payout.submittedAt, null);

      failedPayoutId = payout.id;
      originalSenderBatchId = payout.senderBatchId!;

      const failedEvent = await prisma.ledgerEvent.findFirst({
        where: {
          entityId: payout.id,
          type: "PAYOUT_FAILED",
        },
      });

      assert.ok(failedEvent);

      console.log("PASS: Confirmed rejection recorded as failed.");
      console.log("PASS: Failed payout is eligible for retry.");
    }
  );

  // ------------------------------------------
  // TEST 6: Retry after definitive rejection
  // ------------------------------------------

  await t.test(
    "Retries a failed payout with the same sender batch ID",
    async () => {
      let retrySenderBatchId = "";

      const paypalBatchId = `P5-RETRY-${randomUUID()}`;

      const payout = await releasePayout(
        retryMilestoneId,
        async (input) => {
          retrySenderBatchId = input.senderBatchId;

          return {
            success: true,
            senderBatchId: input.senderBatchId,
            paypalBatchId,
            message: "Retry succeeded",
          };
        }
      );

      assert.equal(payout.id, failedPayoutId);
      assert.equal(payout.status, "processing");
      assert.equal(
        retrySenderBatchId,
        originalSenderBatchId
      );
      assert.equal(payout.paypalBatchId, paypalBatchId);
      assert.ok(payout.submittedAt);

      const retryEvent = await prisma.ledgerEvent.findFirst({
        where: {
          entityId: payout.id,
          type: "PAYOUT_RETRY_STARTED",
        },
      });

      assert.ok(retryEvent);

      console.log("PASS: Failed payout retried with stable batch ID.");
    }
  );

  // ------------------------------------------
  // TEST 7: Unknown outcome
  // ------------------------------------------

  let uncertainMilestoneId = "";
  let uncertainPayoutId = "";

  await t.test(
    "Treats a network timeout as an uncertain outcome",
    async () => {
      const fixture = await createMilestoneFixture();

      uncertainMilestoneId = fixture.milestone.id;

      await assert.rejects(
        releasePayout(
          fixture.milestone.id,
          async () => {
            throw new Error("Simulated network timeout");
          }
        ),
        /outcome is unknown; reconciliation required/
      );

      const payout = await prisma.payout.findUnique({
        where: {
          milestoneId: fixture.milestone.id,
        },
      });

      assert.ok(payout);

      uncertainPayoutId = payout.id;

      assert.equal(
        payout.status,
        "reconciliation_required"
      );

      assert.ok(payout.submissionAttemptStartedAt);
      assert.equal(payout.submittedAt, null);
      assert.equal(payout.paypalBatchId, null);

      const outcomeEvent = await prisma.ledgerEvent.findFirst({
        where: {
          entityId: payout.id,
          type: "PAYOUT_OUTCOME_UNKNOWN",
        },
      });

      assert.ok(outcomeEvent);

      console.log("PASS: Network timeout requires reconciliation.");
      console.log("PASS: Uncertain payout was not marked failed.");
    }
  );

  // ------------------------------------------
  // TEST 8: Do not retry uncertain outcomes
  // ------------------------------------------

  await t.test(
    "Never automatically retries an uncertain payout",
    async () => {
      let senderCalls = 0;

      const payout = await releasePayout(
        uncertainMilestoneId,
        async () => {
          senderCalls++;

          return {
            success: true,
            senderBatchId: "SHOULD-NOT-BE-USED",
            message: "Should not be submitted",
          };
        }
      );

      assert.equal(
        payout.id,
        uncertainPayoutId
      );

      assert.equal(
        payout.status,
        "reconciliation_required"
      );

      assert.equal(senderCalls, 0);

      console.log("PASS: Uncertain payout cannot be resubmitted.");
    }
  );

  // ------------------------------------------
  // TEST 9: Stale payout detection
  // ------------------------------------------

  await t.test(
    "Flags stale processing payouts for reconciliation",
    async () => {
      const staleFixture = await createMilestoneFixture();
      const submittedFixture = await createMilestoneFixture();

      const oldAttempt = new Date(
        Date.now() - 60 * 60 * 1000
      );

      const stalePayout = await prisma.payout.create({
        data: {
          milestoneId: staleFixture.milestone.id,
          amountCents: 5000,
          senderBatchId: `P5-STALE-${randomUUID()}`,
          status: "processing",
          submissionAttemptStartedAt: oldAttempt,
        },
      });

      const alreadySubmittedPayout =
        await prisma.payout.create({
          data: {
            milestoneId: submittedFixture.milestone.id,
            amountCents: 5000,
            senderBatchId: `P5-SUBMITTED-${randomUUID()}`,
            paypalBatchId: `P5-BATCH-${randomUUID()}`,
            status: "processing",
            submissionAttemptStartedAt: oldAttempt,
            submittedAt: new Date(),
          },
        });

      const markedIds =
        await markStalePayoutsForReconciliation(15);

      assert.ok(markedIds.includes(stalePayout.id));

      // A provider-confirmed submission must not be flagged stale.
      assert.ok(
        !markedIds.includes(alreadySubmittedPayout.id)
      );

      const [updatedStale, updatedSubmitted] =
        await Promise.all([
          prisma.payout.findUnique({
            where: { id: stalePayout.id },
          }),

          prisma.payout.findUnique({
            where: { id: alreadySubmittedPayout.id },
          }),
        ]);

      assert.equal(
        updatedStale?.status,
        "reconciliation_required"
      );

      assert.equal(
        updatedSubmitted?.status,
        "processing"
      );

      const event = await prisma.ledgerEvent.findFirst({
        where: {
          entityId: stalePayout.id,
          type: "PAYOUT_RECONCILIATION_REQUIRED",
        },
      });

      assert.ok(event);

      console.log("PASS: Stale payout flagged for reconciliation.");
      console.log("PASS: Confirmed submission was not flagged.");
    }
  );

  // ------------------------------------------
  // TEST 10: Webhook arrives during submission
  // ------------------------------------------

  await t.test(
    "Does not downgrade paid payout when submission response arrives late",
    async () => {
      const fixture = await createMilestoneFixture();

      const paypalBatchId = `P5-RACE-${randomUUID()}`;

      let signalStarted!: () => void;
      let releaseSender!: () => void;

      const senderStarted = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });

      const senderGate = new Promise<void>((resolve) => {
        releaseSender = resolve;
      });

      const firstRequest = releasePayout(
        fixture.milestone.id,
        async (input) => {
          signalStarted();

          // Keep the sender request pending while webhook arrives.
          await senderGate;

          return {
            success: true,
            senderBatchId: input.senderBatchId,
            paypalBatchId,
            message: "Late sender response",
          };
        }
      );

      try {
        // Wait until payout has been claimed and sender is running.
        await senderStarted;

        const payoutDuringSubmission =
          await prisma.payout.findUniqueOrThrow({
            where: {
              milestoneId: fixture.milestone.id,
            },
          });

        assert.equal(
          payoutDuringSubmission.status,
          "processing"
        );

        // Simulate the provider batch ID becoming known to the webhook.
        await prisma.payout.update({
          where: {
            id: payoutDuringSubmission.id,
          },
          data: {
            paypalBatchId,
          },
        });

        // Process a real individual-success state transition.
        await prisma.$transaction((tx) =>
          processPayoutWebhookEvent(
            tx,
            "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
            {
              payout_batch_id: paypalBatchId,
              payout_item_id: `ITEM-${randomUUID()}`,
              transaction_id: `TX-${randomUUID()}`,
            }
          )
        );
      } finally {
        releaseSender();
      }

      const result = await firstRequest;

      const [finalPayout, finalMilestone] =
        await Promise.all([
          prisma.payout.findUnique({
            where: {
              id: result.id,
            },
          }),

          prisma.milestone.findUnique({
            where: {
              id: fixture.milestone.id,
            },
          }),
        ]);

      // Late submission response must not overwrite webhook success.
      assert.equal(finalPayout?.status, "paid");
      assert.equal(finalMilestone?.status, "paid");
      assert.ok(finalPayout?.submittedAt);
      assert.equal(finalPayout?.paypalBatchId, paypalBatchId);

      console.log("PASS: Webhook success survived late sender response.");
      console.log("PASS: Paid payout was never downgraded.");
    }
  );

  // ------------------------------------------
  // TEST 11: Concurrent requests
  // ------------------------------------------

  await t.test(
    "Allows only one concurrent payout submission",
    async () => {
      const fixture = await createMilestoneFixture();

      let senderCalls = 0;
      let signalStarted!: () => void;
      let releaseSender!: () => void;

      const senderStarted = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });

      const senderGate = new Promise<void>((resolve) => {
        releaseSender = resolve;
      });

      const controlledSender = async (
        input: Parameters<typeof sendMockPayout>[0]
      ) => {
        senderCalls++;
        signalStarted();

        await senderGate;

        return {
          success: true,
          senderBatchId: input.senderBatchId,
          paypalBatchId: `P5-CONCURRENT-${randomUUID()}`,
          message: "Concurrent test submitted",
        };
      };

      const firstRequest = releasePayout(
        fixture.milestone.id,
        controlledSender
      );

      try {
        await senderStarted;

        // The second request must see processing and not submit.
        const secondResult = await releasePayout(
          fixture.milestone.id,
          controlledSender
        );

        assert.equal(secondResult.status, "processing");
      } finally {
        releaseSender();
      }

      const firstResult = await firstRequest;

      assert.equal(firstResult.status, "processing");
      assert.equal(senderCalls, 1);

      const payoutCount = await prisma.payout.count({
        where: {
          milestoneId: fixture.milestone.id,
        },
      });

      assert.equal(payoutCount, 1);

      console.log("PASS: Concurrent requests produced one submission.");
    }
  );

  // ------------------------------------------
  // TEST 12: Ledger integrity
  // ------------------------------------------

  await t.test(
    "Maintains ledger integrity after payout operations",
    async () => {
      const result = await verifyChain();

      assert.equal(result.valid, true);

      console.log(
        `PASS: Ledger valid; ${result.checkedEvents} events checked.`
      );
    }
  );
});
