
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
