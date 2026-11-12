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

let paypalShouldFail = false;
let observedRequestBody: Record<string, any> | undefined;
let observedRequestId: string | null = null;

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

    if (url.endsWith("/v2/checkout/orders")) {
      const headers = new Headers(init?.headers);

      observedRequestId = headers.get("PayPal-Request-Id");
      observedRequestBody = JSON.parse(String(init?.body ?? "{}"));

      if (paypalShouldFail) {
        return new Response(
          JSON.stringify({
            name: "INTERNAL_SERVER_ERROR",
            message: "Mock PayPal order creation failure",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      const orderId = `TEST-PAYPAL-ORDER-${randomUUID()}`;

      return new Response(
        JSON.stringify({
          id: orderId,
          status: "PAYER_ACTION_REQUIRED",
          links: [
            {
              rel: "approve",
              href: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
              method: "GET",
            },
          ],
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Allow requests to the local Express server.
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
      "SAFETY STOP: Order route tests require local PostgreSQL."
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

  console.log("Connected to isolated P2 order test database.");
  console.log("Donation order HTTP test server started.");
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

  const donor = await prisma.user.create({
    data: {
      role: "donor",
      name: `Order Test Donor ${suffix}`,
      email: `order-test-${suffix}@example.test`,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Order Test Organization ${suffix}`,
      cause: "Donation order route testing",
      location: "Local test database",
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `Order Test Campaign ${suffix}`,
      goalAmountCents: 100000,
      currency: "USD",
      status: "active",
    },
  });

  return { donor, campaign };
}

function authCookie(userId: string) {
  const token = jwt.sign(
    { sub: userId },
    process.env.JWT_SECRET!,
    { expiresIn: "1h" }
  );

  return `impactledger_token=${token}`;
}

async function sendCreateOrder(
  donorId: string,
  campaignId: string,
  amountCents: number
) {
  return fetch(`${baseUrl}/donations/create-order`, {
    method: "POST",
    headers: {
      Cookie: authCookie(donorId),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ campaignId, amountCents }),
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
// ORDER ROUTE TESTS
// ==========================================

test("Creates PayPal order and records donation correctly", async () => {
  const fixture = await createFixture();

  paypalShouldFail = false;
  observedRequestBody = undefined;
  observedRequestId = null;

  const response = await sendCreateOrder(
    fixture.donor.id,
    fixture.campaign.id,
    500
  );

  const body = await response.json() as Record<string, any>;

  assert.equal(response.status, 201);
  assert.equal(body.status, "pending");
  assert.equal(body.ledgerRecorded, true);
  assert.ok(body.donationId);
  assert.ok(body.orderId);
  assert.match(body.approvalUrl, /^https:\/\/www\.sandbox\.paypal\.com/);

  const saved = await prisma.donation.findUnique({
    where: { id: body.donationId },
  });

  assert.ok(saved);
  assert.equal(saved.donorId, fixture.donor.id);
  assert.equal(saved.campaignId, fixture.campaign.id);
  assert.equal(saved.amountCents, 500);
  assert.equal(saved.status, "pending");
  assert.equal(saved.paypalOrderId, body.orderId);

  assert.equal(observedRequestId, body.donationId);
  assert.equal(observedRequestBody?.intent, "CAPTURE");
  assert.equal(
    observedRequestBody?.purchase_units?.[0]?.custom_id,
    fixture.campaign.id
  );
  assert.equal(
    observedRequestBody?.purchase_units?.[0]?.amount?.value,
    "5.00"
  );
  assert.equal(
    observedRequestBody?.purchase_units?.[0]?.amount?.currency_code,
    "USD"
  );

  assert.equal(
    await countLedgerEvents(body.donationId, "DONATION_ORDER_CREATED"),
    1
  );

  console.log("PASS: PayPal order, donation and ledger recorded.");
});

test("PayPal order failure marks donation failed", async () => {
  const fixture = await createFixture();

  paypalShouldFail = true;

  const response = await sendCreateOrder(
    fixture.donor.id,
    fixture.campaign.id,
    500
  );

  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 502);
  assert.equal(
    body.error,
    "Unable to create PayPal donation order"
  );

  const saved = await prisma.donation.findFirst({
    where: {
      donorId: fixture.donor.id,
      campaignId: fixture.campaign.id,
    },
  });

  assert.ok(saved);
  assert.equal(saved.status, "failed");

  assert.equal(
    await countLedgerEvents(saved.id, "DONATION_ORDER_FAILED"),
    1
  );

  paypalShouldFail = false;

  console.log("PASS: PayPal failure marks donation failed.");
});

test("Rejects an invalid campaign ID", async () => {
  const fixture = await createFixture();

  const response = await sendCreateOrder(
    fixture.donor.id,
    "invalid-campaign-id",
    500
  );

  assert.equal(response.status, 400);

  console.log("PASS: Invalid campaign ID rejected.");
});

test("Rejects a non-positive donation amount", async () => {
  const fixture = await createFixture();

  const response = await sendCreateOrder(
    fixture.donor.id,
    fixture.campaign.id,
    0
  );

  assert.equal(response.status, 400);

  console.log("PASS: Invalid donation amount rejected.");
});

test("Rejects a campaign that does not exist", async () => {
  const fixture = await createFixture();

  const response = await sendCreateOrder(
    fixture.donor.id,
    randomUUID(),
    500
  );

  assert.equal(response.status, 404);

  console.log("PASS: Unknown campaign rejected.");
});
