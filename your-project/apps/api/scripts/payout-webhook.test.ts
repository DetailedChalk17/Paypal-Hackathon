
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";

import { prisma } from "../src/lib/prisma";
import { verifyChain } from "../src/services/ledger.service";

import {
  processPayoutWebhookEvent,
} from "../src/services/payout-webhook.service";

import {
  recalculateOrganizationTrustScore,
} from "../src/services/trust-score.service";

// ==========================================
// SAFETY CHECKS
// ==========================================

before(async () => {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (!/(localhost|127\.0\.0\.1):5432/.test(databaseUrl)) {
    throw new Error(
      "SAFETY STOP: Webhook tests require local PostgreSQL."
    );
  }

  const result = await prisma.$queryRaw<
    Array<{ databaseName: string }>
  >`SELECT current_database() AS "databaseName"`;

  if (result[0]?.databaseName !== "impactledger_p5_test") {
    throw new Error(
      `SAFETY STOP: Expected impactledger_p5_test, connected to ${result[0]?.databaseName}.`
    );
  }

  console.log("Connected to isolated P5 test database.");
});

after(async () => {
  await prisma.$disconnect();
});

// ==========================================
// FIXTURE
// ==========================================

async function createPayoutFixture() {
  const suffix = randomUUID();

  const organization = await prisma.organization.create({
    data: {
      name: `Webhook Test Organization ${suffix}`,
      cause: "Payout webhook testing",
      location: "Local test database",
      payoutEmail: `webhook-${suffix}@example.test`,
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `Webhook Test Campaign ${suffix}`,
      goalAmountCents: 100000,
      currency: "USD",
      status: "active",
    },
  });

  const milestone = await prisma.milestone.create({
    data: {
      campaignId: campaign.id,
      title: `Webhook Test Milestone ${suffix}`,
      budgetAmountCents: 5000,
      status: "approved",
    },
  });

  const batchId = `P5-WEBHOOK-${suffix}`;

  const payout = await prisma.payout.create({
    data: {
      milestoneId: milestone.id,
      amountCents: 5000,
      senderBatchId: `P5-SENDER-${suffix}`,
      paypalBatchId: batchId,
      status: "pending",
    },
  });

  return {
    organization,
    campaign,
    milestone,
    payout,
    batchId,
  };
}

// ==========================================
// WEBHOOK SERVICE INTEGRATION TESTS
// ==========================================

test("P5 payout webhook integration", async (t) => {
  const fixture = await createPayoutFixture();

  const batchResource = {
    batch_header: {
      payout_batch_id: fixture.batchId,
    },
  };

  const itemResource = {
    payout_batch_id: fixture.batchId,
    payout_item_id: `ITEM-${randomUUID()}`,
    transaction_id: `TX-${randomUUID()}`,
  };

  // TEST 1: Unknown batch must be rejected.
  await t.test("Rejects unknown PayPal batch ID", async () => {
    await assert.rejects(
      prisma.$transaction((tx) =>
        processPayoutWebhookEvent(
          tx,
          "PAYMENT.PAYOUTSBATCH.SUCCESS",
          {
            batch_header: {
              payout_batch_id: "UNKNOWN-P5-BATCH",
            },
          }
        )
      ),
      /No payout found/
    );

    console.log("PASS: Unknown batch rejected.");
  });

    // TEST 2: Early webhook correlation using sender batch ID.
  await t.test(
    "Correlates webhook before PayPal batch ID is persisted",
    async () => {
      const earlyFixture = await createPayoutFixture();

      // Simulate the state where PayPal has accepted the payout,
      // but releasePayout() has not yet saved the batch ID.
      await prisma.payout.update({
        where: { id: earlyFixture.payout.id },
        data: { paypalBatchId: null },
      });

      const newPayPalBatchId = `EARLY-${randomUUID()}`;

      const result = await prisma.$transaction((tx) =>
        processPayoutWebhookEvent(
          tx,
          "PAYMENT.PAYOUTSBATCH.SUCCESS",
          {
            batch_header: {
              payout_batch_id: newPayPalBatchId,
              sender_batch_header: {
                sender_batch_id:
                  earlyFixture.payout.senderBatchId,
              },
            },
          }
        )
      );

      const payout = await prisma.payout.findUnique({
        where: { id: earlyFixture.payout.id },
      });

      assert.equal(result.action, "batch_completed");
      assert.equal(payout?.paypalBatchId, newPayPalBatchId);
      assert.equal(payout?.status, "processing");

      console.log(
        "PASS: Early webhook correlated using sender batch ID."
      );
    }
  );

    // TEST 3: Conflicting identifiers must never be associated.
  await t.test(
    "Rejects conflicting sender and PayPal batch IDs",
    async () => {
      const firstFixture = await createPayoutFixture();
      const secondFixture = await createPayoutFixture();

      await prisma.payout.update({
        where: { id: secondFixture.payout.id },
        data: { paypalBatchId: null },
      });

      await assert.rejects(
        prisma.$transaction((tx) =>
          processPayoutWebhookEvent(
            tx,
            "PAYMENT.PAYOUTSBATCH.SUCCESS",
            {
              batch_header: {
                payout_batch_id: firstFixture.batchId,
                sender_batch_header: {
                  sender_batch_id:
                    secondFixture.payout.senderBatchId,
                },
              },
            }
          )
        ),
        /resolve to different payouts/
      );

      const secondPayout = await prisma.payout.findUnique({
        where: { id: secondFixture.payout.id },
      });

      assert.equal(secondPayout?.paypalBatchId, null);

      console.log(
        "PASS: Conflicting identifiers rejected without association."
      );
    }
  );

    // TEST 4: Existing provider batch ID must never be overwritten.
  await t.test(
    "Rejects a different batch ID for an existing payout",
    async () => {
      const testFixture = await createPayoutFixture();

      await assert.rejects(
        prisma.$transaction((tx) =>
          processPayoutWebhookEvent(
            tx,
            "PAYMENT.PAYOUTSBATCH.SUCCESS",
            {
              batch_header: {
                payout_batch_id: `CONFLICT-${randomUUID()}`,
                sender_batch_header: {
                  sender_batch_id:
                    testFixture.payout.senderBatchId,
                },
              },
            }
          )
        ),
        /already associated with a different PayPal batch ID/
      );

      const payout = await prisma.payout.findUnique({
        where: { id: testFixture.payout.id },
      });

      assert.equal(
        payout?.paypalBatchId,
        testFixture.batchId
      );

      console.log(
        "PASS: Existing PayPal batch ID was preserved."
      );
    }
  );

  // TEST 2: Batch success must not prematurely pay milestone.
  await t.test("Batch success keeps payout processing", async () => {
    const result = await prisma.$transaction((tx) =>
      processPayoutWebhookEvent(
        tx,
        "PAYMENT.PAYOUTSBATCH.SUCCESS",
        batchResource
      )
    );

    assert.equal(result.action, "batch_completed");

    const [payout, milestone, batchEvents] =
      await Promise.all([
        prisma.payout.findUnique({
          where: { id: fixture.payout.id },
        }),

        prisma.milestone.findUnique({
          where: { id: fixture.milestone.id },
        }),

        prisma.ledgerEvent.count({
          where: {
            entityId: fixture.payout.id,
            type: "PAYOUT_BATCH_COMPLETED",
          },
        }),
      ]);

    assert.equal(payout?.status, "processing");
    assert.equal(milestone?.status, "approved");
    assert.equal(batchEvents, 1);

    console.log(
      "PASS: Batch success recorded without prematurely paying milestone."
    );
  });

  // TEST 3: Repeated batch success must not duplicate ledger events.
  await t.test("Duplicate batch success is idempotent", async () => {
    await prisma.$transaction((tx) =>
      processPayoutWebhookEvent(
        tx,
        "PAYMENT.PAYOUTSBATCH.SUCCESS",
        batchResource
      )
    );

    const count = await prisma.ledgerEvent.count({
      where: {
        entityId: fixture.payout.id,
        type: "PAYOUT_BATCH_COMPLETED",
      },
    });

    assert.equal(count, 1);

    console.log("PASS: Duplicate batch event did not duplicate ledger.");
  });

  // TEST 4: Individual item success completes the milestone.
  await t.test("Individual success pays payout and milestone", async () => {
    const result = await prisma.$transaction((tx) =>
      processPayoutWebhookEvent(
        tx,
        "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
        itemResource
      )
    );

    assert.equal(result.action, "item_succeeded");
    assert.equal(
      result.organizationId,
      fixture.organization.id
    );

    const [payout, milestone] = await Promise.all([
      prisma.payout.findUnique({
        where: { id: fixture.payout.id },
      }),

      prisma.milestone.findUnique({
        where: { id: fixture.milestone.id },
      }),
    ]);

    assert.equal(payout?.status, "paid");
    assert.equal(milestone?.status, "paid");

    console.log("PASS: Payout and milestone marked paid.");
  });

  // TEST 5: Late failure must never downgrade a paid payout.
  await t.test("Late item failure cannot downgrade a paid payout", async () => {
    await prisma.$transaction((tx) =>
      processPayoutWebhookEvent(
        tx,
        "PAYMENT.PAYOUTS-ITEM.FAILED",
        itemResource
      )
    );

    const payout = await prisma.payout.findUnique({
      where: { id: fixture.payout.id },
    });

    assert.equal(payout?.status, "paid");

    console.log("PASS: Late failure did not downgrade paid payout.");
  });

  // TEST 6: Batch processing and denial map correctly.
  await t.test("Batch processing and denial map correctly", async () => {
    const processingFixture = await createPayoutFixture();

    const processingResult = await prisma.$transaction((tx) =>
      processPayoutWebhookEvent(
        tx,
        "PAYMENT.PAYOUTSBATCH.PROCESSING",
        {
          batch_header: {
            payout_batch_id: processingFixture.batchId,
          },
        }
      )
    );

    const processingPayout = await prisma.payout.findUnique({
      where: { id: processingFixture.payout.id },
    });

    assert.equal(processingResult.action, "batch_processing");
    assert.equal(processingPayout?.status, "processing");

    const deniedFixture = await createPayoutFixture();

    const deniedResult = await prisma.$transaction((tx) =>
      processPayoutWebhookEvent(
        tx,
        "PAYMENT.PAYOUTSBATCH.DENIED",
        {
          batch_header: {
            payout_batch_id: deniedFixture.batchId,
          },
        }
      )
    );

    const deniedPayout = await prisma.payout.findUnique({
      where: { id: deniedFixture.payout.id },
    });

    assert.equal(deniedResult.action, "batch_denied");
    assert.equal(deniedPayout?.status, "reconciliation_required");

    console.log("PASS: Batch processing and denial mapped correctly.");
  });

  // TEST 7: Item failure maps to failed.
  await t.test("Item failure marks payout failed", async () => {
    const failedFixture = await createPayoutFixture();

    const result = await prisma.$transaction((tx) =>
      processPayoutWebhookEvent(
        tx,
        "PAYMENT.PAYOUTS-ITEM.FAILED",
        {
          payout_batch_id: failedFixture.batchId,
          payout_item_id: `ITEM-${randomUUID()}`,
        }
      )
    );

    const payout = await prisma.payout.findUnique({
      where: { id: failedFixture.payout.id },
    });

    assert.equal(result.action, "item_failed");
    assert.equal(payout?.status, "failed");

    console.log("PASS: Item failure mapped to failed.");
  });

  // TEST 8: Non-final item outcomes require manual reconciliation.
  await t.test("Uncertain item outcomes require reconciliation", async () => {
    const eventTypes = [
      "PAYMENT.PAYOUTS-ITEM.BLOCKED",
      "PAYMENT.PAYOUTS-ITEM.HELD",
      "PAYMENT.PAYOUTS-ITEM.CANCELED",
      "PAYMENT.PAYOUTS-ITEM.REFUNDED",
      "PAYMENT.PAYOUTS-ITEM.RETURNED",
      "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
    ];

    for (const eventType of eventTypes) {
      const testFixture = await createPayoutFixture();

      const result = await prisma.$transaction((tx) =>
        processPayoutWebhookEvent(
          tx,
          eventType,
          {
            payout_batch_id: testFixture.batchId,
            payout_item_id: `ITEM-${randomUUID()}`,
          }
        )
      );

      const payout = await prisma.payout.findUnique({
        where: { id: testFixture.payout.id },
      });

      assert.equal(
        result.action,
        "item_requires_reconciliation",
        `${eventType} returned the wrong action`
      );

      assert.equal(
        payout?.status,
        "reconciliation_required",
        `${eventType} returned the wrong payout status`
      );
    }

    console.log("PASS: All uncertain item outcomes require reconciliation.");
  });

  // TEST 5: Trust score updates after committed payout success.
  await t.test("Recalculates organization trust score", async () => {
    await recalculateOrganizationTrustScore(
      fixture.organization.id
    );

    const organization = await prisma.organization.findUnique({
      where: { id: fixture.organization.id },
      select: {
        trustScore: true,
        trustScoreBreakdown: true,
        trustScoreUpdatedAt: true,
      },
    });

    assert.ok(organization);
    assert.ok(organization.trustScoreUpdatedAt);
    assert.ok(organization.trustScoreBreakdown);
    assert.ok(organization.trustScore > 0);

    const breakdown = organization.trustScoreBreakdown as {
      components?: {
        completedMilestones?: {
          earnedPoints?: number;
        };
      };
    };

    assert.equal(
      breakdown.components?.completedMilestones?.earnedPoints,
      20
    );

    console.log(
      `PASS: Organization trust score recalculated to ${organization.trustScore}.`
    );
  });

  // TEST 6: Repeated individual success must not duplicate ledger event.
  await t.test("Duplicate item success does not duplicate ledger", async () => {
    await prisma.$transaction((tx) =>
      processPayoutWebhookEvent(
        tx,
        "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
        itemResource
      )
    );

    const [payoutCount, milestone, successEvents] =
      await Promise.all([
        prisma.payout.count({
          where: { milestoneId: fixture.milestone.id },
        }),

        prisma.milestone.findUnique({
          where: { id: fixture.milestone.id },
        }),

        prisma.ledgerEvent.count({
          where: {
            entityId: fixture.payout.id,
            type: "PAYOUT_ITEM_SUCCEEDED",
          },
        }),
      ]);

    assert.equal(payoutCount, 1);
    assert.equal(milestone?.status, "paid");
    assert.equal(successEvents, 1);

    console.log(
      "PASS: Repeated item success did not duplicate payout or ledger event."
    );
  });

  // TEST 7: The ledger must remain valid.
  await t.test("Ledger integrity remains valid", async () => {
    const result = await verifyChain();

    assert.equal(result.valid, true);

    console.log(
      `PASS: Ledger verified across ${result.checkedEvents} events.`
    );
  });
});
