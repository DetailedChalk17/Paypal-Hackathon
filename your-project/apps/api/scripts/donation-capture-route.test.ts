import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

import { prisma } from "../src/lib/prisma";
import donationPaymentRoutes from "../src/routes/donation-payment.routes";
import { appendEventInTransaction } from "../src/services/ledger.service";

type CaptureStatus = "COMPLETED" | "PENDING" | "DENIED";

type CaptureReply = {
  captureStatus: CaptureStatus;
  captureId: string;
};

type DelayGate = {
  orderId: string;
  started: () => void;
  startedPromise: Promise<void>;
  released: Promise<void>;
  release: () => void;
};

let server: Server | undefined;
let baseUrl = "";
let originalFetch: typeof fetch;

const captureReplies = new Map<string, CaptureReply>();
let delayGate: DelayGate | undefined;

// ==========================================
// PAYPAL MOCK
// ==========================================

function holdCapture(orderId: string) {
  let signalStarted!: () => void;
  let release!: () => void;

  const startedPromise = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });

  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  const gate: DelayGate = {
    orderId,
    started: signalStarted,
    startedPromise,
    released,
    release,
  };

  delayGate = gate;

  return {
    started: startedPromise,
    release,
  };
}

function installPayPalFetchMock() {
  originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    // Fake OAuth. No real PayPal authentication occurs.
    if (url.endsWith("/v1/oauth2/token")) {
      return new Response(
        JSON.stringify({
          access_token: "local-test-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const parsedUrl = new URL(url);
    const match = /\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(
      parsedUrl.pathname
    );

    if (match) {
      const orderId = decodeURIComponent(match[1]);
      const reply = captureReplies.get(orderId);

      if (!reply) {
        return new Response(
          JSON.stringify({ message: "No mock capture response configured" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      const gate =
        delayGate?.orderId === orderId ? delayGate : undefined;

      if (gate) {
        gate.started();
        await gate.released;

        if (delayGate === gate) {
          delayGate = undefined;
        }
      }

      return new Response(
        JSON.stringify({
          id: orderId,
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    id: reply.captureId,
                    status: reply.captureStatus,
                    amount: {
                      currency_code: "USD",
                      value: "12.34",
                    },
                  },
                ],
              },
            },
          ],
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Let requests to our local Express test server use real fetch.
    return originalFetch(input, init);
  }) as typeof fetch;
}

// ==========================================
// TEST DATABASE AND HTTP SERVER
// ==========================================

before(async () => {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (!/(localhost|127\.0\.0\.1):5432/.test(databaseUrl)) {
    throw new Error(
      "SAFETY STOP: Capture route tests require local PostgreSQL."
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

  process.env.JWT_SECRET ??= "local-p6-test-secret-only";
  process.env.PAYPAL_CLIENT_ID ??= "local-test-client";
  process.env.PAYPAL_CLIENT_SECRET ??= "local-test-secret";
  process.env.PAYPAL_ENV = "sandbox";

  installPayPalFetchMock();

  const app = express();
  app.use(cookieParser());
  app.use("/donations", donationPaymentRoutes);

  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => {
      resolve(instance);
    });
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log("Connected to isolated P6 capture test database.");
  console.log("Capture route HTTP test server started.");
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

  if (originalFetch) {
    globalThis.fetch = originalFetch;
  }

  await prisma.$disconnect();
});

// ==========================================
// FIXTURES AND HTTP HELPERS
// ==========================================

async function createDonationFixture() {
  const suffix = randomUUID();
  const orderId = `TEST-ORDER-${suffix}`;

  const donor = await prisma.user.create({
    data: {
      role: "donor",
      name: `Capture Test Donor ${suffix}`,
      email: `capture-test-${suffix}@example.test`,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Capture Test Organization ${suffix}`,
      cause: "Capture route testing",
      location: "Local test database",
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `Capture Test Campaign ${suffix}`,
      goalAmountCents: 100000,
      currency: "USD",
      status: "active",
    },
  });

  const donation = await prisma.donation.create({
    data: {
      campaignId: campaign.id,
      donorId: donor.id,
      amountCents: 1234,
      paypalOrderId: orderId,
      status: "pending",
    },
  });

  return {
    donor,
    donation,
    orderId,
  };
}

function authCookie(userId: string) {
  const token = jwt.sign(
    { sub: userId },
    process.env.JWT_SECRET!,
    { expiresIn: "1h" }
  );

  return `impactledger_token=${token}`;
}

async function sendCapture(
  donationId: string,
  donorId: string
) {
  return fetch(`${baseUrl}/donations/${donationId}/capture`, {
    method: "POST",
    headers: {
      Cookie: authCookie(donorId),
      "Content-Type": "application/json",
    },
  });
}

async function countLedgerEvents(
  donationId: string,
  type: string
) {
  return prisma.ledgerEvent.count({
    where: {
      entityId: donationId,
      type,
    },
  });
}

// ==========================================
// CAPTURE ROUTE TESTS
// ==========================================

test("COMPLETED capture marks donation completed exactly once", async () => {
  const fixture = await createDonationFixture();
  const captureId = `TEST-CAPTURE-${randomUUID()}`;

  captureReplies.set(fixture.orderId, {
    captureStatus: "COMPLETED",
    captureId,
  });

  const response = await sendCapture(
    fixture.donation.id,
    fixture.donor.id
  );

  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.status, "completed");
  assert.equal(body.ledgerRecorded, true);

  const saved = await prisma.donation.findUnique({
    where: { id: fixture.donation.id },
  });

  assert.equal(saved?.status, "completed");
  assert.equal(saved?.paypalCaptureId, captureId);
  assert.equal(
    await countLedgerEvents(
      fixture.donation.id,
      "DONATION_COMPLETED"
    ),
    1
  );

  // A repeated request should use the already-captured response.
  const repeated = await sendCapture(
    fixture.donation.id,
    fixture.donor.id
  );

  const repeatedBody = await repeated.json() as Record<string, unknown>;

  assert.equal(repeated.status, 200);
  assert.equal(repeatedBody.alreadyCaptured, true);
  assert.equal(
    await countLedgerEvents(
      fixture.donation.id,
      "DONATION_COMPLETED"
    ),
    1
  );

  console.log("PASS: Completed capture and repeated request are idempotent.");
});

test("PENDING capture does not count as a completed donation", async () => {
  const fixture = await createDonationFixture();
  const captureId = `TEST-CAPTURE-${randomUUID()}`;

  captureReplies.set(fixture.orderId, {
    captureStatus: "PENDING",
    captureId,
  });

  const response = await sendCapture(
    fixture.donation.id,
    fixture.donor.id
  );

  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 202);
  assert.equal(body.status, "pending");

  const saved = await prisma.donation.findUnique({
    where: { id: fixture.donation.id },
  });

  assert.equal(saved?.status, "pending");
  assert.equal(saved?.paypalCaptureId, captureId);
  assert.equal(
    await countLedgerEvents(
      fixture.donation.id,
      "DONATION_COMPLETED"
    ),
    0
  );

  console.log("PASS: Pending capture is not counted as raised.");
});

test("DENIED capture marks a pending donation failed", async () => {
  const fixture = await createDonationFixture();
  const captureId = `TEST-CAPTURE-${randomUUID()}`;

  captureReplies.set(fixture.orderId, {
    captureStatus: "DENIED",
    captureId,
  });

  const response = await sendCapture(
    fixture.donation.id,
    fixture.donor.id
  );

  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 402);
  assert.equal(body.status, "failed");

  const saved = await prisma.donation.findUnique({
    where: { id: fixture.donation.id },
  });

  assert.equal(saved?.status, "failed");
  assert.equal(saved?.paypalCaptureId, captureId);
  assert.equal(
    await countLedgerEvents(
      fixture.donation.id,
      "DONATION_CAPTURE_DENIED"
    ),
    1
  );

  console.log("PASS: Denied capture marks donation failed.");
});

test("Late DENIED response cannot downgrade a completed donation", async () => {
  const fixture = await createDonationFixture();
  const captureId = `TEST-CAPTURE-${randomUUID()}`;

  captureReplies.set(fixture.orderId, {
    captureStatus: "DENIED",
    captureId,
  });

  const gate = holdCapture(fixture.orderId);

  const responsePromise = sendCapture(
    fixture.donation.id,
    fixture.donor.id
  );

  // Wait until the mocked PayPal capture request is in flight.
  await gate.started;

  // Simulate a successful webhook winning the race.
  await prisma.$transaction(async (tx) => {
    await tx.donation.update({
      where: { id: fixture.donation.id },
      data: {
        status: "completed",
        paypalCaptureId: captureId,
      },
    });

    await appendEventInTransaction(
      tx,
      "DONATION_COMPLETED",
      fixture.donation.id,
      {
        paypalOrderId: fixture.orderId,
        paypalCaptureId: captureId,
        amountCents: 1234,
        currencyCode: "USD",
        source: "test_webhook",
      }
    );
  });

  gate.release();

  const response = await responsePromise;
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.status, "completed");

  const saved = await prisma.donation.findUnique({
    where: { id: fixture.donation.id },
  });

  assert.equal(saved?.status, "completed");
  assert.equal(
    await countLedgerEvents(
      fixture.donation.id,
      "DONATION_CAPTURE_DENIED"
    ),
    0
  );
  assert.equal(
    await countLedgerEvents(
      fixture.donation.id,
      "DONATION_COMPLETED"
    ),
    1
  );

  console.log("PASS: Late denial cannot downgrade completed donation.");
});

test("Late COMPLETED response cannot overwrite a refunded donation", async () => {
  const fixture = await createDonationFixture();
  const captureId = `TEST-CAPTURE-${randomUUID()}`;
  const refundId = `TEST-REFUND-${randomUUID()}`;

  captureReplies.set(fixture.orderId, {
    captureStatus: "COMPLETED",
    captureId,
  });

  const gate = holdCapture(fixture.orderId);

  const responsePromise = sendCapture(
    fixture.donation.id,
    fixture.donor.id
  );

  // Wait until the mocked PayPal capture request is in flight.
  await gate.started;

  // Simulate a completed capture followed by a completed full refund.
  await prisma.$transaction(async (tx) => {
    await tx.donation.update({
      where: { id: fixture.donation.id },
      data: {
        status: "completed",
        paypalCaptureId: captureId,
      },
    });

    await appendEventInTransaction(
      tx,
      "DONATION_COMPLETED",
      fixture.donation.id,
      {
        paypalOrderId: fixture.orderId,
        paypalCaptureId: captureId,
        amountCents: 1234,
        currencyCode: "USD",
        source: "test_webhook",
      }
    );

    await tx.refund.create({
      data: {
        donationId: fixture.donation.id,
        idempotencyKey: `test-refund-${randomUUID()}`,
        paypalRefundId: refundId,
        amountCents: 1234,
        status: "completed",
        completedAt: new Date(),
      },
    });

    await tx.donation.update({
      where: { id: fixture.donation.id },
      data: { status: "refunded" },
    });
  });

  gate.release();

  const response = await responsePromise;
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.status, "refunded");

  const saved = await prisma.donation.findUnique({
    where: { id: fixture.donation.id },
  });

  assert.equal(saved?.status, "refunded");
  assert.equal(
    await countLedgerEvents(
      fixture.donation.id,
      "DONATION_COMPLETED"
    ),
    1
  );

  console.log("PASS: Late capture response cannot overwrite refund.");
});
