
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import { prisma } from "../src/lib/prisma";
import { verifyChain } from "../src/services/ledger.service";
import {
  createPayPalWebhookRouter,
} from "../src/routes/paypal-webhook.routes";
import { reserveRefundRequest } from "../src/services/refund.service";

let server: Server | undefined;
let baseUrl = "";

// Signature verifier state controlled by individual tests.
let signatureIsValid = true;
let verifierCalls = 0;
let observedTransmissionId = "";
let observedRawBody = "";

// ==========================================
// SAFETY AND SERVER SETUP
// ==========================================

before(async () => {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (!/(localhost|127\.0\.0\.1):5432/.test(databaseUrl)) {
    throw new Error(
      "SAFETY STOP: Webhook route tests require local PostgreSQL."
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

  // Do not install express.json() before this router.
  // The PayPal route requires the original raw request body.
  const app = express();

  app.use(
    "/webhooks",
    createPayPalWebhookRouter(async (headers, rawBody) => {
      verifierCalls++;

      observedTransmissionId = headers.transmissionId;
      observedRawBody = rawBody;

      return signatureIsValid;
    })
  );

  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => {
      resolve(instance);
    });
  });

  const address = server.address() as AddressInfo;

  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log("Connected to isolated P5 test database.");
  console.log("PayPal webhook HTTP test server started.");
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  // Retain test records for auditability.
  await prisma.$disconnect();
});

// ==========================================
// HTTP HELPER
// ==========================================

async function sendRawWebhook(rawBody: string) {
  return fetch(`${baseUrl}/webhooks/paypal`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "paypal-transmission-id": "TEST-TRANSMISSION-ID",
      "paypal-transmission-time": "2026-11-09T06:00:00Z",
      "paypal-transmission-sig": "TEST-SIGNATURE",
      "paypal-cert-url": "https://example.test/cert",
      "paypal-auth-algo": "SHA256withRSA",
    },
    body: rawBody,
  });
}

async function sendWebhook(event: unknown) {
  return sendRawWebhook(JSON.stringify(event));
}

// ==========================================
// TEST FIXTURE
// ==========================================

async function createPayoutFixture() {
  const suffix = randomUUID();

  const organization = await prisma.organization.create({
    data: {
      name: `Webhook Route Organization ${suffix}`,
      cause: "Payout webhook route testing",
      location: "Local test database",
      payoutEmail: `webhook-route-${suffix}@example.test`,
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `Webhook Route Campaign ${suffix}`,
      goalAmountCents: 100000,
      currency: "USD",
      status: "active",
    },
  });

  const milestone = await prisma.milestone.create({
    data: {
      campaignId: campaign.id,
      title: `Webhook Route Milestone ${suffix}`,
      budgetAmountCents: 5000,
      status: "approved",
    },
  });

  const batchId = `P5-ROUTE-${suffix}`;

  const payout = await prisma.payout.create({
    data: {
      milestoneId: milestone.id,
      amountCents: 5000,
      senderBatchId: `P5-ROUTE-SENDER-${suffix}`,
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
// PAYPAL WEBHOOK HTTP INTEGRATION TESTS
// ==========================================

test("P5 PayPal webhook HTTP route integration", async (t) => {
  const fixture = await createPayoutFixture();

  // ------------------------------------------
  // TEST 1: Malformed JSON
  // ------------------------------------------

  await t.test("Rejects malformed JSON", async () => {
    const callsBefore = verifierCalls;

    const response = await sendRawWebhook("{invalid-json");

    const body = await response.json() as {
      error?: string;
    };

    assert.equal(response.status, 400);

    assert.equal(
      body.error,
      "Invalid JSON webhook body"
    );

    // Signature verifier should not run for malformed JSON.
    assert.equal(verifierCalls, callsBefore);

    console.log("PASS: Malformed JSON rejected.");
  });

  // ------------------------------------------
  // TEST 2: Invalid signature
  // ------------------------------------------

  await t.test("Rejects invalid signature", async () => {
    signatureIsValid = false;

    const event = {
      id: `WH-INVALID-${randomUUID()}`,
      event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
      resource: {
        batch_header: {
          payout_batch_id: fixture.batchId,
        },
      },
    };

    const rawBody = JSON.stringify(event);

    const response = await sendRawWebhook(rawBody);

    const body = await response.json() as {
      error?: string;
    };

    assert.equal(response.status, 401);

    assert.equal(
      body.error,
      "Invalid PayPal webhook signature"
    );

    // Confirm the verifier received the actual request data.
    assert.equal(
      observedTransmissionId,
      "TEST-TRANSMISSION-ID"
    );

    assert.equal(observedRawBody, rawBody);

    // An event rejected by signature verification must not be stored.
    const storedEvent = await prisma.webhookEvent.findUnique({
      where: {
        paypalEventId: event.id,
      },
    });

    assert.equal(storedEvent, null);

    signatureIsValid = true;

    console.log("PASS: Invalid signature rejected.");
    console.log("PASS: Rejected event was not persisted.");
    console.log("PASS: Raw body and headers reached verifier.");
  });

  // ------------------------------------------
  // TEST 3: Unsupported event
  // ------------------------------------------

  await t.test("Acknowledges unsupported event without storing it", async () => {
    const eventId = `WH-UNSUPPORTED-${randomUUID()}`;

    const response = await sendWebhook({
      id: eventId,
      event_type: "SOME.UNSUPPORTED.EVENT",
      resource: {},
    });

    const body = await response.json() as {
      message?: string;
      eventType?: string;
    };

    assert.equal(response.status, 200);
    assert.equal(body.message, "Event ignored");
    assert.equal(body.eventType, "SOME.UNSUPPORTED.EVENT");

    const storedEvent = await prisma.webhookEvent.findUnique({
      where: {
        paypalEventId: eventId,
      },
    });

    assert.equal(storedEvent, null);

    console.log("PASS: Unsupported event acknowledged and ignored.");
  });

  // ------------------------------------------
  // TEST 4: Payout batch success
  // ------------------------------------------

  const batchEvent = {
    id: `WH-BATCH-${randomUUID()}`,
    event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
    resource: {
      batch_header: {
        payout_batch_id: fixture.batchId,
      },
    },
  };

  await t.test("Processes payout batch success through HTTP route", async () => {
    const response = await sendWebhook(batchEvent);

    const body = await response.json() as {
      message?: string;
      eventId?: string;
      error?: string;
    };

    assert.equal(
      response.status,
      200,
      JSON.stringify(body)
    );

    assert.equal(
      body.message,
      "Webhook processed successfully"
    );

    assert.equal(body.eventId, batchEvent.id);

    const [payout, milestone, webhookEvent, batchEvents] =
      await Promise.all([
        prisma.payout.findUnique({
          where: {
            id: fixture.payout.id,
          },
        }),

        prisma.milestone.findUnique({
          where: {
            id: fixture.milestone.id,
          },
        }),

        prisma.webhookEvent.findUnique({
          where: {
            paypalEventId: batchEvent.id,
          },
        }),

        prisma.ledgerEvent.count({
          where: {
            entityId: fixture.payout.id,
            type: "PAYOUT_BATCH_COMPLETED",
          },
        }),
      ]);

    assert.equal(payout?.status, "processing");

    // Batch success alone must not mark the milestone paid.
    assert.equal(milestone?.status, "approved");

    assert.ok(webhookEvent?.processedAt);

    assert.equal(batchEvents, 1);

    console.log("PASS: Batch webhook processed through HTTP route.");
    console.log("PASS: Payout remains processing.");
    console.log("PASS: Milestone remains approved.");
    console.log("PASS: Webhook event and ledger recorded.");
  });

  // ------------------------------------------
  // TEST 5: Duplicate batch delivery
  // ------------------------------------------

  await t.test("Ignores duplicate batch webhook delivery", async () => {
    const response = await sendWebhook(batchEvent);

    const body = await response.json() as {
      message?: string;
      eventId?: string;
    };

    assert.equal(response.status, 200);

    assert.equal(
      body.message,
      "Duplicate webhook ignored"
    );

    assert.equal(body.eventId, batchEvent.id);

    const [eventCount, batchEventCount] = await Promise.all([
      prisma.webhookEvent.count({
        where: {
          paypalEventId: batchEvent.id,
        },
      }),

      prisma.ledgerEvent.count({
        where: {
          entityId: fixture.payout.id,
          type: "PAYOUT_BATCH_COMPLETED",
        },
      }),
    ]);

    assert.equal(eventCount, 1);
    assert.equal(batchEventCount, 1);

    console.log("PASS: Duplicate batch delivery ignored.");
    console.log("PASS: No duplicate ledger event created.");
  });

  // ------------------------------------------
  // TEST 6: Individual payout success
  // ------------------------------------------

  const itemEvent = {
    id: `WH-ITEM-${randomUUID()}`,
    event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    resource: {
      payout_batch_id: fixture.batchId,
      payout_item_id: `ITEM-${randomUUID()}`,
      transaction_id: `TX-${randomUUID()}`,
    },
  };

  await t.test("Processes payout item success and recalculates trust score", async () => {
    const response = await sendWebhook(itemEvent);

    const body = await response.json() as {
      message?: string;
      eventId?: string;
      error?: string;
    };

    assert.equal(
      response.status,
      200,
      JSON.stringify(body)
    );

    assert.equal(
      body.message,
      "Webhook processed successfully"
    );

    assert.equal(body.eventId, itemEvent.id);

    const [
      payout,
      milestone,
      webhookEvent,
      successEvents,
      organization,
    ] = await Promise.all([
      prisma.payout.findUnique({
        where: {
          id: fixture.payout.id,
        },
      }),

      prisma.milestone.findUnique({
        where: {
          id: fixture.milestone.id,
        },
      }),

      prisma.webhookEvent.findUnique({
        where: {
          paypalEventId: itemEvent.id,
        },
      }),

      prisma.ledgerEvent.count({
        where: {
          entityId: fixture.payout.id,
          type: "PAYOUT_ITEM_SUCCEEDED",
        },
      }),

      prisma.organization.findUnique({
        where: {
          id: fixture.organization.id,
        },
        select: {
          trustScore: true,
          trustScoreUpdatedAt: true,
        },
      }),
    ]);

    assert.equal(payout?.status, "paid");
    assert.equal(milestone?.status, "paid");

    // The route must mark the event processed after trust-score update.
    assert.ok(webhookEvent?.processedAt);

    assert.equal(successEvents, 1);

    assert.ok(organization);
    assert.ok(organization.trustScoreUpdatedAt);
    assert.ok(organization.trustScore >= 0);

    console.log("PASS: Payout marked paid.");
    console.log("PASS: Milestone marked paid.");
    console.log("PASS: Payout success ledger event recorded.");
    console.log("PASS: Trust score recalculated.");
    console.log("PASS: Webhook event marked processed.");
  });

  // ------------------------------------------
  // TEST 7: Duplicate item delivery
  // ------------------------------------------

  await t.test("Ignores duplicate payout item webhook delivery", async () => {
    const response = await sendWebhook(itemEvent);

    const body = await response.json() as {
      message?: string;
      eventId?: string;
    };

    assert.equal(response.status, 200);

    assert.equal(
      body.message,
      "Duplicate webhook ignored"
    );

    assert.equal(body.eventId, itemEvent.id);

    const [
      eventCount,
      payoutCount,
      milestone,
      successEvents,
    ] = await Promise.all([
      prisma.webhookEvent.count({
        where: {
          paypalEventId: itemEvent.id,
        },
      }),

      prisma.payout.count({
        where: {
          milestoneId: fixture.milestone.id,
        },
      }),

      prisma.milestone.findUnique({
        where: {
          id: fixture.milestone.id,
        },
      }),

      prisma.ledgerEvent.count({
        where: {
          entityId: fixture.payout.id,
          type: "PAYOUT_ITEM_SUCCEEDED",
        },
      }),
    ]);

    assert.equal(eventCount, 1);
    assert.equal(payoutCount, 1);
    assert.equal(milestone?.status, "paid");
    assert.equal(successEvents, 1);

    console.log("PASS: Duplicate item delivery ignored.");
    console.log("PASS: No duplicate payout or ledger event.");
  });

  // ------------------------------------------
  // TEST 8: Ledger integrity
  // ------------------------------------------

  await t.test("Maintains ledger integrity after HTTP webhook processing", async () => {
    const result = await verifyChain();

    assert.equal(result.valid, true);

    console.log(
      `PASS: Ledger valid across ${result.checkedEvents} events.`
    );
  });
});

// ==========================================
// P6: REFUND WEBHOOK HTTP INTEGRATION
// ==========================================

test("P6 PayPal refund webhook HTTP integration", async () => {
  const suffix = randomUUID();

  const donor = await prisma.user.create({
    data: {
      role: "donor",
      name: `Refund Webhook Donor ${suffix}`,
      email: `refund-webhook-${suffix}@example.test`,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Refund Webhook Organization ${suffix}`,
      cause: "Refund webhook testing",
      location: "Local test database",
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `Refund Webhook Campaign ${suffix}`,
      goalAmountCents: 100000,
      currency: "USD",
      status: "active",
    },
  });

  const captureId = `REFUND-WEBHOOK-CAPTURE-${suffix}`;

  const donation = await prisma.donation.create({
    data: {
      campaignId: campaign.id,
      donorId: donor.id,
      amountCents: 10000,
      paypalOrderId: `REFUND-WEBHOOK-ORDER-${suffix}`,
      paypalCaptureId: captureId,
      status: "completed",
      completedAt: new Date(),
    },
  });

  // Reserve a $25 partial refund against the $100 donation.
  const reservation = await reserveRefundRequest({
    donationId: donation.id,
    idempotencyKey: `refund-webhook-${suffix}`,
    amountCents: 2500,
    noteToPayer: "HTTP integration test",
  });



  if (!reservation.ok) {
    throw new Error(
      `Refund reservation failed: ${reservation.error}`
    );
  }

  const refundId = reservation.refund.id;
  const paypalRefundId = `PAYPAL-REFUND-${suffix}`;
  const eventId = `WH-REFUND-${suffix}`;

  const refundEvent = {
    id: eventId,
    event_type: "PAYMENT.CAPTURE.REFUNDED",
    resource: {
      id: paypalRefundId,
      status: "COMPLETED",
      custom_id: refundId,
      amount: {
        value: "25.00",
        currency_code: "USD",
      },
      supplementary_data: {
        related_ids: {
          capture_id: captureId,
        },
      },
    },
  };

  // ------------------------------------------
  // TEST 1: Refund webhook through HTTP route
  // ------------------------------------------

  const response = await sendWebhook(refundEvent);

  const body = await response.json() as {
    message?: string;
    eventId?: string;
    error?: string;
  };

  assert.equal(
    response.status,
    200,
    JSON.stringify(body)
  );

  assert.equal(
    body.message,
    "Webhook processed successfully"
  );

  assert.equal(body.eventId, eventId);

  const [
    refund,
    webhookEvent,
    completionEvents,
    donationAfterRefund,
  ] = await Promise.all([
    prisma.refund.findUnique({
      where: {
        id: refundId,
      },
    }),

    prisma.webhookEvent.findUnique({
      where: {
        paypalEventId: eventId,
      },
    }),

    prisma.ledgerEvent.count({
      where: {
        entityId: refundId,
        type: "DONATION_REFUND_COMPLETED",
      },
    }),

    prisma.donation.findUnique({
      where: {
        id: donation.id,
      },
    }),
  ]);

  assert.equal(refund?.status, "completed");
  assert.equal(refund?.paypalRefundId, paypalRefundId);
  assert.ok(refund?.completedAt);

  assert.ok(webhookEvent?.processedAt);

  assert.equal(completionEvents, 1);

  // A partial refund must not mark the entire donation refunded.
  assert.equal(donationAfterRefund?.status, "completed");

  console.log("PASS: Refund webhook completed the reserved Refund.");
  console.log("PASS: PayPal refund ID was correlated correctly.");
  console.log("PASS: Completion ledger event recorded.");
  console.log("PASS: Partial refund preserved Donation status.");

  // ------------------------------------------
  // TEST 2: Duplicate refund webhook delivery
  // ------------------------------------------

  const duplicateResponse = await sendWebhook(refundEvent);

  const duplicateBody = await duplicateResponse.json() as {
    message?: string;
    eventId?: string;
  };

  assert.equal(duplicateResponse.status, 200);

  assert.equal(
    duplicateBody.message,
    "Duplicate webhook ignored"
  );

  assert.equal(duplicateBody.eventId, eventId);

  const [eventCount, eventsAfterDuplicate] = await Promise.all([
    prisma.webhookEvent.count({
      where: {
        paypalEventId: eventId,
      },
    }),

    prisma.ledgerEvent.count({
      where: {
        entityId: refundId,
        type: "DONATION_REFUND_COMPLETED",
      },
    }),
  ]);

  assert.equal(eventCount, 1);
  assert.equal(eventsAfterDuplicate, 1);

  console.log("PASS: Duplicate refund webhook ignored.");
  console.log("PASS: No duplicate completion ledger event.");
});

// ==========================================
// P6: CAPTURE DENIAL HTTP INTEGRATION
// ==========================================

test("P6 PayPal capture denied HTTP integration", async () => {
  const suffix = randomUUID();

  const donor = await prisma.user.create({
    data: {
      role: "donor",
      name: `Capture Denial Donor ${suffix}`,
      email: `capture-denial-${suffix}@example.test`,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Capture Denial Organization ${suffix}`,
      cause: "Capture denial testing",
      location: "Local test database",
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `Capture Denial Campaign ${suffix}`,
      goalAmountCents: 100000,
      currency: "USD",
      status: "active",
    },
  });

  // ------------------------------------------
  // TEST 1: Pending donation becomes failed
  // ------------------------------------------

  const orderId = `DENIED-ORDER-${suffix}`;
  const captureId = `DENIED-CAPTURE-${suffix}`;
  const eventId = `WH-DENIED-${suffix}`;

  const pendingDonation = await prisma.donation.create({
    data: {
      campaignId: campaign.id,
      donorId: donor.id,
      amountCents: 10000,
      paypalOrderId: orderId,
      paypalCaptureId: null,
      status: "pending",
    },
  });

  const deniedEvent = {
    id: eventId,
    event_type: "PAYMENT.CAPTURE.DENIED",
    resource: {
      id: captureId,
      status: "DECLINED",
      amount: {
        value: "100.00",
        currency_code: "USD",
      },
      supplementary_data: {
        related_ids: {
          order_id: orderId,
        },
      },
    },
  };

  const response = await sendWebhook(deniedEvent);

  const body = await response.json() as {
    message?: string;
    eventId?: string;
    error?: string;
  };

  assert.equal(
    response.status,
    200,
    JSON.stringify(body)
  );

  assert.equal(
    body.message,
    "Webhook processed successfully"
  );

  assert.equal(body.eventId, eventId);

  const [failedDonation, webhookEvent, denialEvents] =
    await Promise.all([
      prisma.donation.findUnique({
        where: { id: pendingDonation.id },
      }),

      prisma.webhookEvent.findUnique({
        where: { paypalEventId: eventId },
      }),

      prisma.ledgerEvent.count({
        where: {
          entityId: pendingDonation.id,
          type: "DONATION_CAPTURE_DENIED",
        },
      }),
    ]);

  assert.equal(failedDonation?.status, "failed");
  assert.equal(failedDonation?.paypalCaptureId, captureId);
  assert.ok(webhookEvent?.processedAt);
  assert.equal(denialEvents, 1);

  console.log("PASS: Pending donation changed to failed.");
  console.log("PASS: Denied capture ID was saved.");
  console.log("PASS: Capture denial ledger event recorded.");

  // ------------------------------------------
  // TEST 2: Duplicate denial delivery
  // ------------------------------------------

  const duplicateResponse = await sendWebhook(deniedEvent);

  const duplicateBody = await duplicateResponse.json() as {
    message?: string;
    eventId?: string;
  };

  assert.equal(duplicateResponse.status, 200);
  assert.equal(
    duplicateBody.message,
    "Duplicate webhook ignored"
  );
  assert.equal(duplicateBody.eventId, eventId);

  const eventsAfterDuplicate = await prisma.ledgerEvent.count({
    where: {
      entityId: pendingDonation.id,
      type: "DONATION_CAPTURE_DENIED",
    },
  });

  assert.equal(eventsAfterDuplicate, 1);

  console.log("PASS: Duplicate denial webhook ignored.");
  console.log("PASS: No duplicate denial ledger event.");

  // ------------------------------------------
  // TEST 3: Late denial must not downgrade
  // a successfully completed donation.
  // ------------------------------------------

  const completedOrderId = `COMPLETED-ORDER-${suffix}`;
  const completedCaptureId = `COMPLETED-CAPTURE-${suffix}`;
  const lateEventId = `WH-LATE-DENIED-${suffix}`;

  const completedDonation = await prisma.donation.create({
    data: {
      campaignId: campaign.id,
      donorId: donor.id,
      amountCents: 10000,
      paypalOrderId: completedOrderId,
      paypalCaptureId: completedCaptureId,
      status: "completed",
      completedAt: new Date(),
    },
  });

  const lateDeniedEvent = {
    id: lateEventId,
    event_type: "PAYMENT.CAPTURE.DENIED",
    resource: {
      id: completedCaptureId,
      status: "DECLINED",
      amount: {
        value: "100.00",
        currency_code: "USD",
      },
      supplementary_data: {
        related_ids: {
          order_id: completedOrderId,
        },
      },
    },
  };

  const lateResponse = await sendWebhook(lateDeniedEvent);

  const lateBody = await lateResponse.json() as {
    message?: string;
    eventId?: string;
    error?: string;
  };

  assert.equal(
    lateResponse.status,
    200,
    JSON.stringify(lateBody)
  );

  assert.equal(
    lateBody.message,
    "Webhook processed successfully"
  );

  const [preservedDonation, lateDenialEvents, lateWebhookEvent] =
    await Promise.all([
      prisma.donation.findUnique({
        where: { id: completedDonation.id },
      }),

      prisma.ledgerEvent.count({
        where: {
          entityId: completedDonation.id,
          type: "DONATION_CAPTURE_DENIED",
        },
      }),

      prisma.webhookEvent.findUnique({
        where: { paypalEventId: lateEventId },
      }),
    ]);

  assert.equal(preservedDonation?.status, "completed");
  assert.equal(lateDenialEvents, 0);
  assert.ok(lateWebhookEvent?.processedAt);

  console.log("PASS: Late denial did not downgrade completed donation.");
  console.log("PASS: No false denial ledger event recorded.");
});
// ==========================================
// P7: WEBHOOK FAILURE-PATH TESTS
// ==========================================

test("P7 unmatched payout requires reconciliation", async () => {
  const eventId = `WH-UNMATCHED-${randomUUID()}`;
  const unknownBatchId = `UNKNOWN-BATCH-${randomUUID()}`;

  const response = await sendWebhook({
    id: eventId,
    event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
    resource: {
      batch_header: {
        payout_batch_id: unknownBatchId,
      },
    },
  });

  const body = await response.json() as {
    message?: string;
    eventId?: string;
    status?: string;
  };

  assert.equal(response.status, 200);
  assert.equal(body.status, "reconciliation_required");
  assert.equal(body.eventId, eventId);

  const storedEvent = await prisma.webhookEvent.findUnique({
    where: { paypalEventId: eventId },
  });

  assert.ok(storedEvent);
  assert.equal(
    storedEvent.processingStatus,
    "reconciliation_required"
  );
  assert.ok(storedEvent.lastError?.includes(unknownBatchId));

  console.log("PASS: Unmatched payout requires reconciliation.");
  console.log("PASS: Webhook receipt preserved without payout association.");
});


test("P7 transient processing failure becomes retryable", async () => {
  const eventId = `WH-RETRYABLE-${randomUUID()}`;

  const response = await sendWebhook({
    id: eventId,
    event_type: "PAYMENT.CAPTURE.DENIED",
    resource: {
      id: `UNKNOWN-CAPTURE-${randomUUID()}`,
      status: "DECLINED",
      amount: {
        value: "10.00",
        currency_code: "USD",
      },
      supplementary_data: {
        related_ids: {
          order_id: `UNKNOWN-ORDER-${randomUUID()}`,
        },
      },
    },
  });

  const body = await response.json() as {
    error?: string;
  };

  assert.equal(response.status, 500);
  assert.equal(body.error, "Webhook processing failed");

  const storedEvent = await prisma.webhookEvent.findUnique({
    where: { paypalEventId: eventId },
  });

  assert.ok(storedEvent);
  assert.equal(storedEvent.processingStatus, "retryable");
  assert.ok(storedEvent.lastError);

  console.log("PASS: Transient processing failure returned HTTP 500.");
  console.log("PASS: Webhook receipt marked retryable.");
});


test("P7 event already processing is not acknowledged as complete", async () => {
  const eventId = `WH-PROCESSING-${randomUUID()}`;

  await prisma.webhookEvent.create({
    data: {
      paypalEventId: eventId,
      eventType: "PAYMENT.PAYOUTSBATCH.SUCCESS",
      resourceId: `RESOURCE-${randomUUID()}`,
      payload: {
        id: eventId,
        event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
        resource: {},
      },
      processingStatus: "processing",
    },
  });

  const response = await sendWebhook({
    id: eventId,
    event_type: "PAYMENT.PAYOUTSBATCH.SUCCESS",
    resource: {},
  });

  const storedEvent = await prisma.webhookEvent.findUnique({
    where: { paypalEventId: eventId },
  });

  assert.equal(response.status, 503);
  assert.equal(storedEvent?.processingStatus, "processing");

  console.log("PASS: In-progress webhook delivery returns HTTP 503.");
});