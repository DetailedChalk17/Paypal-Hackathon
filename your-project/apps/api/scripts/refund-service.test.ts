
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import {
  completeRefundFromWebhookInTransaction,
  getNetDonationAmountsCents,
  reserveRefundRequest,
  updateRefundFromPayPalResponse,
} from "../src/services/refund.service";
const prisma = new PrismaClient();

let donationId = "";
let captureId = "";
let lifecycleDonationId = "";

before(async () => {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (!/(localhost|127\.0\.0\.1):5432/.test(databaseUrl)) {
    throw new Error("SAFETY STOP: Local PostgreSQL required.");
  }

  const result = await prisma.$queryRaw<
    Array<{ databaseName: string }>
  >`SELECT current_database() AS "databaseName"`;

  if (result[0]?.databaseName !== "impactledger_p5_test") {
    throw new Error(
      `SAFETY STOP: Expected impactledger_p5_test, connected to ${result[0]?.databaseName}.`
    );
  }

  const suffix = randomUUID();

  const donor = await prisma.user.create({
    data: {
      role: "donor",
      name: `Refund Test Donor ${suffix}`,
      email: `refund-test-${suffix}@example.test`,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Refund Test Organization ${suffix}`,
      cause: "Refund service testing",
      location: "Local test database",
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `Refund Test Campaign ${suffix}`,
      goalAmountCents: 100000,
      currency: "USD",
      status: "active",
    },
  });

  captureId = `TEST-CAPTURE-${suffix}`;

  const donation = await prisma.donation.create({
    data: {
      campaignId: campaign.id,
      donorId: donor.id,
      amountCents: 10000,
      paypalOrderId: `TEST-ORDER-${suffix}`,
      paypalCaptureId: captureId,
      status: "completed",
      completedAt: new Date(),
    },
  });

  donationId = donation.id;
  const lifecycleDonation = await prisma.donation.create({
  data: {
    campaignId: campaign.id,
    donorId: donor.id,
    amountCents: 10000,
    paypalOrderId: `TEST-LIFECYCLE-ORDER-${suffix}`,
    paypalCaptureId: `TEST-LIFECYCLE-CAPTURE-${suffix}`,
    status: "completed",
    completedAt: new Date(),
  },
});

lifecycleDonationId = lifecycleDonation.id;

  console.log("Connected to isolated refund test database.");
});

after(async () => {
  await prisma.$disconnect();
});

test("Refund reservation safety", async (t) => {
  let firstRefundId = "";

  await t.test("Creates a partial refund reservation", async () => {
    const result = await reserveRefundRequest({
      donationId,
      idempotencyKey: "refund-test-key-1",
      amountCents: 3000,
      noteToPayer: "Test partial refund",
    });

    assert.equal(result.ok, true);

    if (!result.ok) return;

    assert.equal(result.duplicate, false);
    assert.equal(result.refund.amountCents, 3000);
    assert.equal(result.refund.status, "processing");

    firstRefundId = result.refund.id;

    const ledgerCount = await prisma.ledgerEvent.count({
      where: {
        entityId: firstRefundId,
        type: "DONATION_REFUND_REQUESTED",
      },
    });

    assert.equal(ledgerCount, 1);

    console.log("PASS: Partial refund reserved and recorded in ledger.");
  });

  await t.test("Returns existing record for duplicate request", async () => {
    const result = await reserveRefundRequest({
      donationId,
      idempotencyKey: "refund-test-key-1",
      amountCents: 3000,
      noteToPayer: "Test partial refund",
    });

    assert.equal(result.ok, true);

    if (!result.ok) return;

    assert.equal(result.duplicate, true);
    assert.equal(result.refund.id, firstRefundId);

    console.log("PASS: Duplicate request reused original refund.");
  });

  await t.test("Rejects same key with different details", async () => {
    const result = await reserveRefundRequest({
      donationId,
      idempotencyKey: "refund-test-key-1",
      amountCents: 4000,
      noteToPayer: "Different amount",
    });

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.statusCode, 409);
    }

    console.log("PASS: Idempotency key cannot be reused with different details.");
  });

  await t.test("Blocks another refund while first is processing", async () => {
    const result = await reserveRefundRequest({
      donationId,
      idempotencyKey: "refund-test-key-2",
      amountCents: 2000,
    });

    assert.equal(result.ok, false);

    if (!result.ok) {
      assert.equal(result.statusCode, 409);
    }

    console.log("PASS: Concurrent unresolved refund blocked.");
  });

  await t.test("Subtracts historical P3 refunds from balance", async () => {
    // Simulate a refund completed before the new Refund model existed.
    const legacyRefundId = `LEGACY-REFUND-${randomUUID()}`;

    await prisma.webhookEvent.create({
      data: {
        paypalEventId: `LEGACY-WEBHOOK-${randomUUID()}`,
        eventType: "PAYMENT.CAPTURE.REFUNDED",
        resourceId: legacyRefundId,
        payload: {
          id: `LEGACY-WEBHOOK-${randomUUID()}`,
          event_type: "PAYMENT.CAPTURE.REFUNDED",
          resource: {
            id: legacyRefundId,
            status: "COMPLETED",
            amount: {
              value: "50.00",
              currency_code: "USD",
            },
            supplementary_data: {
              related_ids: {
                capture_id: captureId,
              },
            },
          },
        },
      },
    });

    // The first reservation is still processing.
    // Simulate PayPal confirming that it was cancelled.
    await prisma.refund.update({
      where: { id: firstRefundId },
      data: { status: "cancelled" },
    });

    // Original: $100
    // Legacy completed refund: $50
    // Cancelled new refund: $0
    // Remaining: $50
    const excessive = await reserveRefundRequest({
      donationId,
      idempotencyKey: "refund-test-key-3",
      amountCents: 6000,
    });

    assert.equal(excessive.ok, false);

    if (!excessive.ok) {
      assert.equal(excessive.statusCode, 409);
    }

    const valid = await reserveRefundRequest({
      donationId,
      idempotencyKey: "refund-test-key-4",
      amountCents: 5000,
    });

    assert.equal(valid.ok, true);

    if (valid.ok) {
      assert.equal(valid.refund.amountCents, 5000);
    }

    console.log("PASS: Legacy refund deducted from refundable balance.");
  });
});

test("Refund completion ordering and idempotency", async (t) => {
  await t.test("API response arrives before webhook", async () => {
    const reservation = await reserveRefundRequest({
      donationId: lifecycleDonationId,
      idempotencyKey: "lifecycle-api-first",
      amountCents: 2500,
    });

    assert.equal(reservation.ok, true);
    if (!reservation.ok) return;

    const refundId = reservation.refund.id;
    const paypalRefundId = `TEST-API-FIRST-${randomUUID()}`;

    // PayPal API responds first with PENDING.
    const apiResult = await updateRefundFromPayPalResponse(
      refundId,
      {
        refundId: paypalRefundId,
        status: "PENDING",
      }
    );

    assert.equal(apiResult.status, "pending");
    assert.equal(apiResult.paypalRefundId, paypalRefundId);

    // PayPal webhook subsequently confirms completion.
    const webhookResult = await prisma.$transaction((tx) =>
      completeRefundFromWebhookInTransaction(tx, {
        donationId: lifecycleDonationId,
        paypalRefundId,
        customId: refundId,
        amountCents: 2500,
      })
    );

    assert.equal(webhookResult.matched, true);
    assert.equal(webhookResult.refund?.status, "completed");

    const completionEvents = await prisma.ledgerEvent.count({
      where: {
        entityId: refundId,
        type: "DONATION_REFUND_COMPLETED",
      },
    });

    assert.equal(completionEvents, 1);

    // Deliver the same webhook again.
    const duplicateResult = await prisma.$transaction((tx) =>
      completeRefundFromWebhookInTransaction(tx, {
        donationId: lifecycleDonationId,
        paypalRefundId,
        customId: refundId,
        amountCents: 2500,
      })
    );

    assert.equal(duplicateResult.matched, true);
    assert.equal(duplicateResult.refund?.status, "completed");

    const eventsAfterDuplicate = await prisma.ledgerEvent.count({
      where: {
        entityId: refundId,
        type: "DONATION_REFUND_COMPLETED",
      },
    });

    assert.equal(eventsAfterDuplicate, 1);

    console.log("PASS: API-first refund completed; duplicate webhook was idempotent.");
  });

  await t.test("Webhook arrives before API response", async () => {
    const reservation = await reserveRefundRequest({
      donationId: lifecycleDonationId,
      idempotencyKey: "lifecycle-webhook-first",
      amountCents: 3500,
    });

    assert.equal(reservation.ok, true);
    if (!reservation.ok) return;

    const refundId = reservation.refund.id;
    const paypalRefundId = `TEST-WEBHOOK-FIRST-${randomUUID()}`;

    // Webhook arrives before the API response.
    // custom_id identifies our internal Refund record.
    const webhookResult = await prisma.$transaction((tx) =>
      completeRefundFromWebhookInTransaction(tx, {
        donationId: lifecycleDonationId,
        paypalRefundId,
        customId: refundId,
        amountCents: 3500,
      })
    );

    assert.equal(webhookResult.matched, true);
    assert.equal(webhookResult.refund?.status, "completed");
    assert.equal(webhookResult.refund?.paypalRefundId, paypalRefundId);

    // A delayed API response must not downgrade completion.
    const apiResult = await updateRefundFromPayPalResponse(
      refundId,
      {
        refundId: paypalRefundId,
        status: "PENDING",
      }
    );

    assert.equal(apiResult.status, "completed");
    assert.equal(apiResult.paypalRefundId, paypalRefundId);

    const completionEvents = await prisma.ledgerEvent.count({
      where: {
        entityId: refundId,
        type: "DONATION_REFUND_COMPLETED",
      },
    });

    assert.equal(completionEvents, 1);

    console.log("PASS: Webhook-first refund remained completed after delayed API response.");
  });
});
test("Net donation accounting", async () => {
  const donation = await prisma.donation.findUnique({
    where: {
      id: lifecycleDonationId,
    },
    include: {
      campaign: {
        select: {
          currency: true,
        },
      },
    },
  });

  assert.ok(donation);
  assert.ok(donation.paypalCaptureId);

  const completedRefunds = await prisma.refund.findMany({
    where: {
      donationId: donation.id,
      status: "completed",
    },
    select: {
      id: true,
      paypalRefundId: true,
      amountCents: true,
    },
  });

  assert.equal(completedRefunds.length, 2);

  const mappedRefund = completedRefunds.find(
    (refund) => refund.paypalRefundId !== null
  );

  assert.ok(mappedRefund?.paypalRefundId);

  // Simulate a historical webhook for a refund that is
  // already represented in the Refund table.
  const mappedEventId = `MAPPED-DUP-${randomUUID()}`;

  await prisma.webhookEvent.create({
    data: {
      paypalEventId: mappedEventId,
      eventType: "PAYMENT.CAPTURE.REFUNDED",
      resourceId: mappedRefund.paypalRefundId,
      payload: {
        id: mappedEventId,
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        resource: {
          id: mappedRefund.paypalRefundId,
          custom_id: mappedRefund.id,
          status: "COMPLETED",
          amount: {
            value: (mappedRefund.amountCents / 100).toFixed(2),
            currency_code: donation.campaign.currency,
          },
          supplementary_data: {
            related_ids: {
              capture_id: donation.paypalCaptureId,
            },
          },
        },
      },
    },
  });

  // Simulate an older P3 refund with no Refund table record.
  const legacyRefundId = `LEGACY-NET-${randomUUID()}`;
  const legacyEventId = `LEGACY-NET-WH-${randomUUID()}`;

  await prisma.webhookEvent.create({
    data: {
      paypalEventId: legacyEventId,
      eventType: "PAYMENT.CAPTURE.REFUNDED",
      resourceId: legacyRefundId,
      payload: {
        id: legacyEventId,
        event_type: "PAYMENT.CAPTURE.REFUNDED",
        resource: {
          id: legacyRefundId,
          status: "COMPLETED",
          amount: {
            value: "15.00",
            currency_code: donation.campaign.currency,
          },
          supplementary_data: {
            related_ids: {
              capture_id: donation.paypalCaptureId,
            },
          },
        },
      },
    },
  });

  // A pending refund must not reduce the contribution.
  await prisma.refund.create({
    data: {
      donationId: donation.id,
      idempotencyKey: `pending-accounting-${randomUUID()}`,
      amountCents: 500,
      status: "pending",
    },
  });

  const netAmounts = await getNetDonationAmountsCents(
    prisma,
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

  // Original:               10000 cents
  // Completed P6 refunds:    2500 + 3500
  // Historical P3 refund:    1500
  // Duplicate mapped event:  ignored
  // Pending refund:          ignored
  // Expected net:            2500 cents

  assert.equal(netAmounts.get(donation.id), 2500);

  console.log(
    "PASS: Net contribution includes completed P6 and legacy P3 refunds exactly once."
  );
});
