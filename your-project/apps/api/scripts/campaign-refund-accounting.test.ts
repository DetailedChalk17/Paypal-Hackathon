import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";

import { prisma } from "../src/lib/prisma";
import campaignRoutes from "../src/routes/campaign.routes";

let server: Server | undefined;
let baseUrl = "";

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
  app.use("/campaigns", campaignRoutes);

  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => {
      resolve(instance);
    });
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log("Connected to isolated campaign test database.");
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

test("Campaign raised amount reflects completed partial refunds", async () => {
  const suffix = randomUUID();

  const donor = await prisma.user.create({
    data: {
      role: "donor",
      name: `Campaign Refund Donor ${suffix}`,
      email: `campaign-refund-${suffix}@example.test`,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Campaign Refund Organization ${suffix}`,
      cause: "Campaign refund accounting",
      location: "Local test database",
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `Campaign Refund Test ${suffix}`,
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
      paypalOrderId: `CAMPAIGN-ORDER-${suffix}`,
      paypalCaptureId: `CAMPAIGN-CAPTURE-${suffix}`,
      status: "completed",
      completedAt: new Date(),
    },
  });

  await prisma.refund.create({
    data: {
      donationId: donation.id,
      idempotencyKey: `campaign-refund-${suffix}`,
      paypalRefundId: `PAYPAL-CAMPAIGN-REFUND-${suffix}`,
      amountCents: 2500,
      status: "completed",
      completedAt: new Date(),
    },
  });

  const response = await fetch(
    `${baseUrl}/campaigns/${campaign.id}`
  );

  const body = await response.json() as {
    raisedAmountCents?: number;
    error?: string;
  };

  assert.equal(
    response.status,
    200,
    JSON.stringify(body)
  );

  assert.equal(
    body.raisedAmountCents,
    7500,
    "A $100 donation with a $25 completed refund should contribute $75."
  );

  console.log("PASS: Campaign endpoint subtracts completed partial refunds.");
  console.log("PASS: Net raised amount is 7500 cents ($75).");
});
