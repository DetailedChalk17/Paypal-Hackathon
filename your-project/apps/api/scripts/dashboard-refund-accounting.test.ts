import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import { prisma } from "../src/lib/prisma";
import dashboardRoutes from "../src/routes/dashboard.routes";
import { appendEvent } from "../src/services/ledger.service";

let server: Server | undefined;
let baseUrl = "";

type DashboardResponse = {
  donationsByDay: {
    date: string;
    donationCount: number;
    amountCents: number;
  }[];
  fundingGaps: {
    campaignId: string;
    raisedAmountCents: number;
    fundingGapCents: number;
  }[];
  error?: string;
};

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

  const app = express();
  app.use("/dashboard", dashboardRoutes);

  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => {
      resolve(instance);
    });
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log("Connected to isolated dashboard test database.");
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

  await prisma.$disconnect();
});

test("Dashboard daily donations reflect completed refunds", async () => {
  // Capture the existing dashboard values so unrelated test
  // records on the same day do not affect the assertion.
  const beforeResponse = await fetch(`${baseUrl}/dashboard/summary`);
  const beforeBody =
    await beforeResponse.json() as DashboardResponse;

  assert.equal(
    beforeResponse.status,
    200,
    JSON.stringify(beforeBody)
  );

  const suffix = randomUUID();

  const donor = await prisma.user.create({
    data: {
      role: "donor",
      name: `Dashboard Refund Donor ${suffix}`,
      email: `dashboard-refund-${suffix}@example.test`,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Dashboard Refund Organization ${suffix}`,
      cause: "Dashboard refund accounting",
      location: "Local test database",
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `Dashboard Refund Campaign ${suffix}`,
      goalAmountCents: 100000,
      currency: "USD",
      status: "active",
    },
  });

  const captureId = `DASHBOARD-CAPTURE-${suffix}`;

  const donation = await prisma.donation.create({
    data: {
      campaignId: campaign.id,
      donorId: donor.id,
      amountCents: 10000,
      paypalOrderId: `DASHBOARD-ORDER-${suffix}`,
      paypalCaptureId: captureId,
      status: "completed",
      completedAt: new Date(),
    },
  });

  // Create a real chained donation-completion ledger event.
  await appendEvent(
    "DONATION_COMPLETED",
    donation.id,
    {
      amountCents: donation.amountCents,
      currencyCode: "USD",
      source: "dashboard_accounting_test",
    }
  );

  // Record a completed $25 partial refund.
  await prisma.refund.create({
    data: {
      donationId: donation.id,
      idempotencyKey: `dashboard-refund-${suffix}`,
      paypalRefundId: `PAYPAL-DASHBOARD-REFUND-${suffix}`,
      amountCents: 2500,
      status: "completed",
      completedAt: new Date(),
    },
  });

  // Get the date using the same PostgreSQL DATE() logic
  // used by the dashboard query.
  const eventDates = await prisma.$queryRaw<
    Array<{ date: string }>
  >`
    SELECT TO_CHAR(DATE("createdAt"), 'YYYY-MM-DD') AS "date"
    FROM "LedgerEvent"
    WHERE "type" = 'DONATION_COMPLETED'
  AND "entityId" = ${donation.id}::uuid
    ORDER BY "createdAt" DESC
    LIMIT 1
  `;

  assert.ok(eventDates[0]?.date);

  const date = eventDates[0].date;

  const previousDay = beforeBody.donationsByDay.find(
    (item) => item.date === date
  );

  const previousAmount = previousDay?.amountCents ?? 0;
  const previousCount = previousDay?.donationCount ?? 0;

  const afterResponse = await fetch(`${baseUrl}/dashboard/summary`);
  const afterBody =
    await afterResponse.json() as DashboardResponse;

  assert.equal(
    afterResponse.status,
    200,
    JSON.stringify(afterBody)
  );

  const updatedDay = afterBody.donationsByDay.find(
    (item) => item.date === date
  );

  assert.ok(updatedDay, `Missing dashboard date bucket ${date}`);

  assert.equal(
    updatedDay.amountCents - previousAmount,
    7500,
    "A $100 donation with a $25 completed refund should add $75 net."
  );

  assert.equal(
    updatedDay.donationCount - previousCount,
    1,
    "A completed donation should still count as one donation."
  );

  const fundingGap = afterBody.fundingGaps.find(
    (item) => item.campaignId === campaign.id
  );

  assert.ok(fundingGap, "Expected the active campaign in funding gaps.");

  assert.equal(fundingGap.raisedAmountCents, 7500);
  assert.equal(fundingGap.fundingGapCents, 92500);

  console.log("PASS: Dashboard subtracts completed partial refunds.");
  console.log("PASS: Daily net contribution increased by 7500 cents ($75).");
  console.log("PASS: Donation count remains one successful donation.");
});
