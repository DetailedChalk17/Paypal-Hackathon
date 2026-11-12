import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

import { prisma } from "../src/lib/prisma";
import donationDataRoutes from "../src/routes/donation-data.routes";

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

  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured.");
  }

  const app = express();
  app.use(cookieParser());
  app.use("/donations", donationDataRoutes);

  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => {
      resolve(instance);
    });
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log("Connected to isolated donation reporting test database.");
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

test("Donation receipt and graph use net contribution after refunds", async () => {
  const suffix = randomUUID();

  const donor = await prisma.user.create({
    data: {
      role: "donor",
      name: `Net Reporting Donor ${suffix}`,
      email: `net-reporting-${suffix}@example.test`,
    },
  });

  const organization = await prisma.organization.create({
    data: {
      name: `Net Reporting Organization ${suffix}`,
      cause: "Donation net accounting",
      location: "Local test database",
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `Net Reporting Campaign ${suffix}`,
      goalAmountCents: 10000,
      currency: "USD",
      status: "active",
    },
  });

  const milestone = await prisma.milestone.create({
    data: {
      campaignId: campaign.id,
      title: `Net Reporting Milestone ${suffix}`,
      budgetAmountCents: 10000,
      status: "approved",
    },
  });

  const donation = await prisma.donation.create({
    data: {
      campaignId: campaign.id,
      donorId: donor.id,
      amountCents: 10000,
      paypalOrderId: `NET-REPORTING-ORDER-${suffix}`,
      paypalCaptureId: `NET-REPORTING-CAPTURE-${suffix}`,
      status: "completed",
      completedAt: new Date(),
    },
  });

  await prisma.refund.create({
    data: {
      donationId: donation.id,
      idempotencyKey: `net-reporting-refund-${suffix}`,
      paypalRefundId: `PAYPAL-NET-REPORTING-REFUND-${suffix}`,
      amountCents: 2500,
      status: "completed",
      completedAt: new Date(),
    },
  });

  const token = jwt.sign(
    {},
    process.env.JWT_SECRET!,
    {
      subject: donor.id,
      expiresIn: "10m",
    }
  );

  const headers = {
    Cookie: `impactledger_token=${token}`,
  };

  // ------------------------------------------
  // TEST 1: Donation receipt
  // ------------------------------------------

  const receiptResponse = await fetch(
    `${baseUrl}/donations/${donation.id}/receipt`,
    { headers }
  );

  const receipt = await receiptResponse.json() as {
    donation?: {
      amountCents: number;
      netAmountCents: number;
      refundedAmountCents: number;
    };
    allocation?: {
      allocatedAmountCents: number;
      refundedAmountCents: number;
      allocations: {
        milestoneId: string;
        allocatedAmountCents: number;
      }[];
    };
    error?: string;
  };

  assert.equal(
    receiptResponse.status,
    200,
    JSON.stringify(receipt)
  );

  assert.equal(receipt.donation?.amountCents, 10000);
  assert.equal(receipt.donation?.netAmountCents, 7500);
  assert.equal(receipt.donation?.refundedAmountCents, 2500);

  assert.equal(receipt.allocation?.allocatedAmountCents, 7500);
  assert.equal(receipt.allocation?.refundedAmountCents, 2500);

  const milestoneAllocation = receipt.allocation?.allocations.find(
    (item) => item.milestoneId === milestone.id
  );

  assert.equal(milestoneAllocation?.allocatedAmountCents, 7500);

  console.log("PASS: Receipt preserves the original $100 donation.");
  console.log("PASS: Receipt reports $75 net and $25 refunded.");
  console.log("PASS: Milestone allocation uses $75 net contribution.");

  // ------------------------------------------
  // TEST 2: Donation graph / trace
  // ------------------------------------------

  const traceResponse = await fetch(
    `${baseUrl}/donations/${donation.id}/trace`,
    { headers }
  );

  const trace = await traceResponse.json() as {
    donationId?: string;
    nodes?: Record<string, unknown>[];
    links?: Record<string, unknown>[];
    error?: string;
  };

  assert.equal(
    traceResponse.status,
    200,
    JSON.stringify(trace)
  );

  assert.equal(trace.donationId, donation.id);

  const donationNode = trace.nodes?.find(
    (node) => node.id === `donation:${donation.id}`
  );

  assert.ok(donationNode);
  assert.equal(donationNode.amountCents, 10000);
  assert.equal(donationNode.netAmountCents, 7500);
  assert.equal(donationNode.refundedAmountCents, 2500);

  const fundingLink = trace.links?.find(
    (link) => link.id === "donation-to-campaign"
  );

  assert.ok(fundingLink);
  assert.equal(fundingLink.amountCents, 7500);

  const milestoneNode = trace.nodes?.find(
    (node) => node.id === `milestone:${milestone.id}`
  );

  assert.ok(milestoneNode);
  assert.equal(milestoneNode.allocatedAmountCents, 7500);

  console.log("PASS: Graph preserves the original donation amount.");
  console.log("PASS: Graph funding link uses $75 net contribution.");
  console.log("PASS: Graph milestone allocation uses $75.");
});
