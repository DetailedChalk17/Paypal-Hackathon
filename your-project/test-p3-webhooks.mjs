import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const amount = "5.00";

async function postEvent(event) {
  const response = await fetch(`${baseUrl}/webhooks/paypal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `${event.event_type} returned HTTP ${response.status}: ${JSON.stringify(body)}`
    );
  }

  console.log(`✓ ${event.event_type}: HTTP ${response.status} — ${body.message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

try {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.PAYPAL_ENV !== "sandbox" ||
    process.env.PAYPAL_WEBHOOK_TEST_MODE !== "true"
  ) {
    throw new Error(
      "Refusing to run. Start the API with NODE_ENV=development, PAYPAL_ENV=sandbox and PAYPAL_WEBHOOK_TEST_MODE=true."
    );
  }

  const [campaign, donor, milestone] = await Promise.all([
    prisma.campaign.findFirst({ select: { id: true, currency: true } }),
    prisma.user.findFirst({ select: { id: true } }),
    prisma.milestone.findFirst({ select: { id: true } }),
  ]);

  if (!campaign || !donor || !milestone) {
    throw new Error(
      "Need at least one Campaign, User and Milestone in the local database. Run your normal seed script first."
    );
  }

  const currency = campaign.currency;
  const deniedOrderId = `TEST-DENIED-ORDER-${suffix}`;
  const deniedCaptureId = `TEST-DENIED-CAPTURE-${suffix}`;
  const refundCaptureId = `TEST-REFUND-CAPTURE-${suffix}`;
  const payoutBatchId = `TEST-PAYOUT-BATCH-${suffix}`;

  const deniedDonation = await prisma.donation.create({
    data: {
      campaignId: campaign.id,
      donorId: donor.id,
      amountCents: 500,
      paypalOrderId: deniedOrderId,
      status: "pending",
    },
  });

  const refundDonation = await prisma.donation.create({
    data: {
      campaignId: campaign.id,
      donorId: donor.id,
      amountCents: 500,
      paypalOrderId: `TEST-REFUND-ORDER-${suffix}`,
      paypalCaptureId: refundCaptureId,
      status: "completed",
    },
  });

  const payout = await prisma.payout.create({
    data: {
      milestoneId: milestone.id,
      amountCents: 100,
      senderBatchId: `TEST-SENDER-BATCH-${suffix}`,
      paypalBatchId: payoutBatchId,
      status: "pending",
    },
  });

  console.log("\nCreated local test records:");
  console.log({
    deniedDonationId: deniedDonation.id,
    refundDonationId: refundDonation.id,
    payoutId: payout.id,
    currency,
  });

  // 1. Capture denied
  await postEvent({
    id: `WH-TEST-DENIED-${suffix}`,
    event_type: "PAYMENT.CAPTURE.DENIED",
    resource_type: "capture",
    resource: {
      id: deniedCaptureId,
      status: "DECLINED",
      amount: { value: amount, currency_code: currency },
      supplementary_data: {
        related_ids: { order_id: deniedOrderId },
      },
    },
  });

  // 2. Capture refunded
  await postEvent({
    id: `WH-TEST-REFUNDED-${suffix}`,
    event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource_type: "refund",
    resource: {
      id: `TEST-REFUND-ID-${suffix}`,
      status: "COMPLETED",
      amount: { value: amount, currency_code: currency },
      links: [
        {
          rel: "up",
          href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${refundCaptureId}`,
          method: "GET",
        },
      ],
      seller_payable_breakdown: {
        total_refunded_amount: {
          value: amount,
          currency_code: currency,
        },
      },
    },
  });

  // 3. Payout batch succeeded
  await postEvent({
    id: `WH-TEST-PAYOUT-BATCH-${suffix}`,
    event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
    resource_type: "payout",
    resource: {
      batch_header: {
        payout_batch_id: payoutBatchId,
        batch_status: "SUCCESS",
      },
    },
  });

  // 4. Payout item succeeded
  await postEvent({
    id: `WH-TEST-PAYOUT-ITEM-${suffix}`,
    event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    resource_type: "payout_item",
    resource: {
      payout_batch_id: payoutBatchId,
      payout_item_id: `TEST-PAYOUT-ITEM-${suffix}`,
      transaction_id: `TEST-PAYOUT-TX-${suffix}`,
      transaction_status: "SUCCESS",
    },
  });

  const [deniedAfter, refundAfter, payoutAfter, ledgerRows, webhookRows] =
    await Promise.all([
      prisma.donation.findUnique({ where: { id: deniedDonation.id } }),
      prisma.donation.findUnique({ where: { id: refundDonation.id } }),
      prisma.payout.findUnique({ where: { id: payout.id } }),

      prisma.ledgerEvent.findMany({
        where: {
          entityId: {
            in: [deniedDonation.id, refundDonation.id, payout.id],
          },
        },
        select: { entityId: true, type: true },
        orderBy: { createdAt: "asc" },
      }),

      prisma.webhookEvent.findMany({
        where: {
          eventType: {
            in: [
              "PAYMENT.CAPTURE.DENIED",
              "PAYMENT.CAPTURE.REFUNDED",
              "PAYMENT.PAYOUTSBATCH.SUCCESS",
              "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
            ],
          },
          paypalEventId: { startsWith: "WH-TEST-" },
        },
        select: {
          paypalEventId: true,
          eventType: true,
          processedAt: true,
        },
        orderBy: { receivedAt: "asc" },
      }),
    ]);

  assert(
    deniedAfter?.status === "failed",
    "denied donation should be failed"
  );

  assert(
    refundAfter?.status === "refunded",
    "refunded donation should be refunded"
  );

  assert(
    payoutAfter?.status === "paid",
    "payout should end as paid"
  );

  const expectedTypes = [
    "DONATION_CAPTURE_DENIED",
    "DONATION_REFUNDED",
    "PAYOUT_BATCH_COMPLETED",
    "PAYOUT_ITEM_SUCCEEDED",
  ];

  const actualTypes = ledgerRows.map((row) => row.type);

  for (const type of expectedTypes) {
    assert(actualTypes.includes(type), `ledger should contain ${type}`);
  }

  assert(webhookRows.length === 4, "all four webhook records should be stored");

  assert(
    webhookRows.every((row) => row.processedAt),
    "all four webhook records should have processedAt set"
  );

  console.log("\nPASS — handler results:");

  console.table([
    {
      handler: "CAPTURE.DENIED",
      finalStatus: deniedAfter.status,
      ledgerEvent: "DONATION_CAPTURE_DENIED",
    },
    {
      handler: "CAPTURE.REFUNDED",
      finalStatus: refundAfter.status,
      ledgerEvent: "DONATION_REFUNDED",
    },
    {
      handler: "PAYOUTSBATCH.SUCCESS",
      finalStatus: payoutAfter.status,
      ledgerEvent: "PAYOUT_BATCH_COMPLETED",
    },
    {
      handler: "PAYOUTS-ITEM.SUCCEEDED",
      finalStatus: payoutAfter.status,
      ledgerEvent: "PAYOUT_ITEM_SUCCEEDED",
    },
  ]);

  console.log(
    "\nTest rows are intentionally retained in the local DB so the ledger stays auditable."
  );

  console.log(
    "Test webhook IDs:",
    webhookRows.map((row) => row.paypalEventId).join(", ")
  );
} catch (error) {
  console.error("\nP3 webhook fixture test FAILED:", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}