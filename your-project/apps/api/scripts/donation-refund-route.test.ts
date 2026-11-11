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

let server: Server | undefined;
let baseUrl = "";
let originalFetch: typeof fetch;

let paypalMode: "completed" | "uncertain" = "completed";
let refundCalls = 0;
let observedRefundBody: Record<string, any> | undefined;
let observedRequestId: string | null = null;
let observedRefundPath = "";

// ==========================================
// PAYPAL MOCK
// ==========================================

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
    const match =
      /\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(
        parsedUrl.pathname
      );

    if (match) {
      refundCalls++;

      observedRefundPath = decodeURIComponent(match[1]);

      const headers = new Headers(init?.headers);
      observedRequestId = headers.get("PayPal-Request-Id");

      observedRefundBody = JSON.parse(
        String(init?.body ?? "{}")
      );

      if (paypalMode === "uncertain") {
        throw new Error("Mock PayPal network failure");
      }

      return new Response(
        JSON.stringify({
          id: `TEST-PAYPAL-REFUND-${randomUUID()}`,
          status: "COMPLETED",
          custom_id: observedRefundBody.custom_id,
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
      "SAFETY STOP: Refund route tests require local PostgreSQL."
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

  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured.");
  }

  process.env.PAYPAL_CLIENT_ID ??= "local-test-client";
  process.env.PAYPAL_CLIENT_SECRET ??= "local-test-secret";
  process.env.PAYPAL_ENV = "sandbox";

  installPayPalFetchMock();

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/donations", donationPaymentRoutes);

  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => {
      resolve(instance);
    });
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log("Connected to isolated P6 refund test database.");
  console.log("Refund route HTTP test server started.");
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

async function createFixture() {
  const suffix = randomUUID();

  const reviewer = await prisma.user.create({
    data: {
      role: "reviewer",
      name: `Refund Route Reviewer ${suffix}`,
      email: `refund-reviewer-${suffix}@example.test`,
    },
  });

  const donor = await prisma.user.create({
    data: {
      role: "donor",
      name: `Refund Route Donor ${suffix}`,
      email: `refund-donor-${suffix}@example.test`,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Refund Route Organization ${suffix}`,
      cause: "Refund HTTP route testing",
      location: "Local test database",
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `Refund Route Campaign ${suffix}`,
      goalAmountCents: 100000,
      currency: "USD",
      status: "active",
    },
  });

  const donation = await prisma.donation.create({
    data: {
      campaignId: campaign.id,
      donorId: donor.id,
      amountCents: 10000,
      paypalOrderId: `TEST-ORDER-${suffix}`,
      paypalCaptureId: `TEST-CAPTURE-${suffix}`,
      status: "completed",
      completedAt: new Date(),
    },
  });

  return { reviewer, donor, donation };
}

function authCookie(userId: string) {
  const token = jwt.sign(
    { sub: userId },
    process.env.JWT_SECRET!,
    { expiresIn: "1h" }
  );

  return `impactledger_token=${token}`;
}

async function sendRefund(
  donationId: string,
  userId: string,
  idempotencyKey?: string,
  body: Record<string, unknown> = {}
) {
  const headers: Record<string, string> = {
    Cookie: authCookie(userId),
    "Content-Type": "application/json",
  };

  if (idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  return fetch(
    `${baseUrl}/donations/${donationId}/refunds`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }
  );
}

// ==========================================
// REFUND HTTP ROUTE TESTS
// ==========================================

test("P6 refund HTTP route integration", async (t) => {
  const fixture = await createFixture();

  const partialRefundKey = `partial-${randomUUID()}`;

  paypalMode = "completed";
  refundCalls = 0;
  observedRefundBody = undefined;
  observedRequestId = null;

  let partialRefundId = "";
  let initialRefundCalls = 0;

  // ------------------------------------------
  // TEST 1: Reviewer creates a partial refund
  // ------------------------------------------

  await t.test(
    "Reviewer successfully creates a partial refund",
    async () => {
      const response = await sendRefund(
        fixture.donation.id,
        fixture.reviewer.id,
        partialRefundKey,
        {
          amountCents: 2500,
          noteToPayer: "Test partial refund",
        }
      );

      const body = await response.json() as Record<string, any>;

      assert.equal(response.status, 200);
      assert.equal(body.message, "Refund request processed");
      assert.equal(body.refund.status, "completed");
      assert.equal(body.refund.amountCents, 2500);
      assert.ok(body.refund.id);
      assert.ok(body.refund.paypalRefundId);

      partialRefundId = body.refund.id;
      initialRefundCalls = refundCalls;

      const savedRefund = await prisma.refund.findUnique({
        where: { id: partialRefundId },
      });

      assert.ok(savedRefund);
      assert.equal(savedRefund.donationId, fixture.donation.id);
      assert.equal(savedRefund.amountCents, 2500);
      assert.equal(savedRefund.status, "completed");

      assert.equal(
        await prisma.ledgerEvent.count({
          where: {
            entityId: partialRefundId,
            type: "DONATION_REFUND_REQUESTED",
          },
        }),
        1
      );

      assert.equal(
        await prisma.ledgerEvent.count({
          where: {
            entityId: partialRefundId,
            type: "DONATION_REFUND_COMPLETED",
          },
        }),
        1
      );

      const savedDonation = await prisma.donation.findUnique({
        where: { id: fixture.donation.id },
      });

      // Partial refund does not change donation status.
      assert.equal(savedDonation?.status, "completed");

      assert.equal(observedRefundPath, fixture.donation.paypalCaptureId);
      assert.equal(observedRequestId, partialRefundId);
      assert.equal(observedRefundBody?.custom_id, partialRefundId);

      assert.deepEqual(observedRefundBody?.amount, {
        currency_code: "USD",
        value: "25.00",
      });

      assert.equal(
        observedRefundBody?.note_to_payer,
        "Test partial refund"
      );

      console.log("PASS: Partial refund completed through HTTP route.");
      console.log("PASS: PayPal refund request used stable IDs.");
      console.log("PASS: Refund ledger events recorded.");
    }
  );

  // ------------------------------------------
  // TEST 2: Duplicate request
  // ------------------------------------------

  await t.test(
    "Duplicate idempotency key does not call PayPal again",
    async () => {
      const response = await sendRefund(
        fixture.donation.id,
        fixture.reviewer.id,
        partialRefundKey,
        {
          amountCents: 2500,
          noteToPayer: "Test partial refund",
        }
      );

      const body = await response.json() as Record<string, any>;

      assert.equal(response.status, 200);
      assert.equal(body.duplicate, true);
      assert.equal(body.refund.id, partialRefundId);

      assert.equal(refundCalls, initialRefundCalls);

      console.log("PASS: Duplicate request reused existing refund.");
    }
  );

  // ------------------------------------------
  // TEST 3: Idempotency mismatch
  // ------------------------------------------

  await t.test(
    "Rejects reuse of key with different refund details",
    async () => {
      const response = await sendRefund(
        fixture.donation.id,
        fixture.reviewer.id,
        partialRefundKey,
        { amountCents: 3000 }
      );

      assert.equal(response.status, 409);
      assert.equal(refundCalls, initialRefundCalls);

      console.log("PASS: Idempotency mismatch rejected.");
    }
  );

  // ------------------------------------------
  // TEST 4: Missing idempotency key
  // ------------------------------------------

  await t.test(
    "Rejects missing Idempotency-Key header",
    async () => {
      const response = await sendRefund(
        fixture.donation.id,
        fixture.reviewer.id
      );

      assert.equal(response.status, 400);
      assert.equal(refundCalls, initialRefundCalls);

      console.log("PASS: Missing idempotency key rejected.");
    }
  );

  // ------------------------------------------
  // TEST 5: Donor authorization
  // ------------------------------------------

  await t.test(
    "Rejects refund request from donor",
    async () => {
      const response = await sendRefund(
        fixture.donation.id,
        fixture.donor.id,
        `donor-${randomUUID()}`,
        { amountCents: 1000 }
      );

      assert.equal(response.status, 403);
      assert.equal(refundCalls, initialRefundCalls);

      console.log("PASS: Donor cannot initiate reviewer refund.");
    }
  );

  // ------------------------------------------
  // TEST 6: Invalid donation ID
  // ------------------------------------------

  await t.test(
    "Rejects invalid donation ID",
    async () => {
      const response = await sendRefund(
        "invalid-id",
        fixture.reviewer.id,
        `invalid-${randomUUID()}`,
        { amountCents: 1000 }
      );

      assert.equal(response.status, 400);
      assert.equal(refundCalls, initialRefundCalls);

      console.log("PASS: Invalid donation ID rejected.");
    }
  );

  // ------------------------------------------
  // TEST 7: Uncertain PayPal outcome
  // ------------------------------------------

  await t.test(
    "Persists uncertain PayPal outcome for reconciliation",
    async () => {
      const secondDonation = await prisma.donation.create({
        data: {
          campaignId: fixture.donation.campaignId,
          donorId: fixture.donor.id,
          amountCents: 10000,
          paypalOrderId: `TEST-UNCERTAIN-ORDER-${randomUUID()}`,
          paypalCaptureId: `TEST-UNCERTAIN-CAPTURE-${randomUUID()}`,
          status: "completed",
          completedAt: new Date(),
        },
      });

      const key = `uncertain-${randomUUID()}`;

      paypalMode = "uncertain";
      const callsBefore = refundCalls;

      const response = await sendRefund(
        secondDonation.id,
        fixture.reviewer.id,
        key,
        { amountCents: 1000 }
      );

      const body = await response.json() as Record<string, any>;

      assert.equal(response.status, 202);
      assert.equal(
        body.message,
        "Refund outcome is uncertain and requires reconciliation"
      );
      assert.equal(
        body.refund.status,
        "reconciliation_required"
      );

      const savedRefund = await prisma.refund.findUnique({
        where: { id: body.refund.id },
      });

      assert.ok(savedRefund);
      assert.equal(
        savedRefund.status,
        "reconciliation_required"
      );

      assert.equal(refundCalls, callsBefore + 1);

      // A repeated request must not submit another PayPal refund.
      const duplicate = await sendRefund(
        secondDonation.id,
        fixture.reviewer.id,
        key,
        { amountCents: 1000 }
      );

      const duplicateBody =
        await duplicate.json() as Record<string, any>;

      assert.equal(duplicate.status, 202);
      assert.equal(duplicateBody.duplicate, true);
      assert.equal(duplicateBody.refund.id, savedRefund.id);
      assert.equal(refundCalls, callsBefore + 1);

      paypalMode = "completed";

      console.log("PASS: Uncertain outcome requires reconciliation.");
      console.log("PASS: Duplicate uncertain refund did not resubmit.");
    }
  );
});
