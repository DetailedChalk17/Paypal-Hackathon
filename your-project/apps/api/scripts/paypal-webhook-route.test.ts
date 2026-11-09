
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
