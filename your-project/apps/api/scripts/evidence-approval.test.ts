
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

import { prisma } from "../src/lib/prisma";
import evidenceRoutes from "../src/routes/evidence.routes";
import { verifyChain } from "../src/services/ledger.service";

// ==========================================
// SERVER STATE
// ==========================================

let server: Server | undefined;
let baseUrl = "";

// ==========================================
// TEST USER
// ==========================================

async function createTestUser(role: "reviewer" | "donor") {
  const suffix = randomUUID();

  return prisma.user.create({
    data: {
      role,
      name: `P5 Test ${role} ${suffix}`,
      email: `p5-${role}-${suffix}@example.test`,
    },
  });
}

// ==========================================
// SAFETY AND SERVER SETUP
// ==========================================

before(async () => {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (!/(localhost|127\.0\.0\.1):5432/.test(databaseUrl)) {
    throw new Error(
      "SAFETY STOP: Approval tests require local PostgreSQL."
    );
  }

  const databaseInfo = await prisma.$queryRaw<
    Array<{ databaseName: string }>
  >`SELECT current_database() AS "databaseName"`;

  if (databaseInfo[0]?.databaseName !== "impactledger_p5_test") {
    throw new Error(
      `SAFETY STOP: Expected impactledger_p5_test, connected to ${databaseInfo[0]?.databaseName}.`
    );
  }

  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured.");
  }

  // Run the actual evidence router with real authentication middleware.
  const app = express();

  app.use(cookieParser());
  app.use("/evidence", evidenceRoutes);

  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => {
      resolve(instance);
    });
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  console.log("Connected to isolated P5 test database.");
  console.log("Evidence integration test server started.");
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

  // Retain test records for auditability in the isolated database.
  await prisma.$disconnect();
});

// ==========================================
// HTTP HELPERS
// ==========================================

function createToken(userId: string): string {
  return jwt.sign(
    {},
    process.env.JWT_SECRET!,
    {
      subject: userId,
      expiresIn: "10m",
    }
  );
}

async function evidenceRequest(
  action: "approve" | "retry-payout",
  evidenceId: string,
  token?: string
) {
  return fetch(`${baseUrl}/evidence/${evidenceId}/${action}`, {
    method: "POST",
    headers: token
      ? {
          Cookie: `impactledger_token=${token}`,
        }
      : {},
  });
}

async function approveEvidence(
  evidenceId: string,
  token?: string
) {
  return evidenceRequest("approve", evidenceId, token);
}

async function retryPayout(
  evidenceId: string,
  token?: string
) {
  return evidenceRequest("retry-payout", evidenceId, token);
}

// ==========================================
// APPROVAL AND RETRY INTEGRATION TESTS
// ==========================================

test("P5 evidence approval and payout retry integration", async (t) => {
  const reviewer = await createTestUser("reviewer");
  const donor = await createTestUser("donor");

  const suffix = randomUUID();

  const organization = await prisma.organization.create({
    data: {
      name: `P5 Approval Organization ${suffix}`,
      cause: "Approval and retry integration testing",
      location: "Local test database",
      payoutEmail: `approval-${suffix}@example.test`,
    },
  });

  const campaign = await prisma.campaign.create({
    data: {
      organizationId: organization.id,
      title: `P5 Approval Campaign ${suffix}`,
      goalAmountCents: 100000,
      currency: "USD",
      status: "active",
    },
  });

  // Primary milestone for the approval workflow.
  const milestone = await prisma.milestone.create({
    data: {
      campaignId: campaign.id,
      title: `Approval Test Milestone ${suffix}`,
      budgetAmountCents: 5000,
      status: "evidence_submitted",
      dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  const evidence = await prisma.evidence.create({
    data: {
      milestoneId: milestone.id,
      file: "p5-approval-test-evidence.pdf",
      extractedFields: {},
      aiFindings: {},
    },
  });

  const reviewerToken = createToken(reviewer.id);
  const donorToken = createToken(donor.id);

  // Separate fixture identifiers for failed-payout retry tests.
  let retryEvidenceId = "";
  let retryMilestoneId = "";
  let retryPayoutId = "";
  let retrySenderBatchId = "";

  // ------------------------------------------
  // TEST 1: Unauthenticated approval request
  // ------------------------------------------

  await t.test("Rejects approval without authentication", async () => {
    const response = await approveEvidence(evidence.id);

    assert.equal(response.status, 401);

    console.log("PASS: Unauthenticated approval rejected.");
  });

  // ------------------------------------------
  // TEST 2: Incorrect role cannot approve
  // ------------------------------------------

  await t.test("Rejects approval from non-reviewer", async () => {
    const response = await approveEvidence(
      evidence.id,
      donorToken
    );

    assert.equal(response.status, 403);

    console.log("PASS: Non-reviewer approval rejected.");
  });

  // ------------------------------------------
  // TEST 3: Actual reviewer approval
  // ------------------------------------------

  await t.test(
    "Reviewer approval initiates exactly one payout",
    async () => {
      const response = await approveEvidence(
        evidence.id,
        reviewerToken
      );

      const body = await response.json() as {
        message?: string;
        evidenceId?: string;
        milestoneId?: string;
        payout?: {
          id: string;
          status: string;
          amountCents: number;
          senderBatchId: string;
        };
        trustScore?: {
          score: number;
        };
        error?: string;
      };

      assert.equal(
        response.status,
        200,
        JSON.stringify(body)
      );

      assert.equal(body.evidenceId, evidence.id);
      assert.equal(body.milestoneId, milestone.id);

      assert.equal(
        body.message,
        "Evidence approved and payout submitted"
      );

      assert.ok(body.payout);
      assert.equal(body.payout.status, "processing");
      assert.equal(body.payout.amountCents, 5000);

      assert.ok(body.payout.id);
      assert.ok(body.payout.senderBatchId);

      assert.ok(body.trustScore);
      assert.ok(body.trustScore.score >= 0);

      const [
        updatedEvidence,
        updatedMilestone,
        payoutCount,
      ] = await Promise.all([
        prisma.evidence.findUnique({
          where: { id: evidence.id },
        }),

        prisma.milestone.findUnique({
          where: { id: milestone.id },
        }),

        prisma.payout.count({
          where: { milestoneId: milestone.id },
        }),
      ]);

      assert.equal(
        updatedEvidence?.reviewerDecision,
        "approved"
      );

      assert.equal(updatedMilestone?.status, "approved");
      assert.equal(payoutCount, 1);

      const payoutEvents = await prisma.ledgerEvent.findMany({
        where: { entityId: body.payout.id },
        select: { type: true },
      });

      const eventTypes = payoutEvents.map(
        (event) => event.type
      );

      assert.ok(eventTypes.includes("PAYOUT_INITIATED"));
      assert.ok(eventTypes.includes("PAYOUT_BATCH_SUBMITTED"));

      const updatedOrganization =
        await prisma.organization.findUnique({
          where: { id: organization.id },
          select: {
            trustScore: true,
            trustScoreUpdatedAt: true,
          },
        });

      assert.ok(updatedOrganization?.trustScoreUpdatedAt);

      console.log("PASS: Reviewer approval triggered payout.");
      console.log("PASS: Evidence and milestone updated.");
      console.log("PASS: Payout ledger events recorded.");
      console.log("PASS: Trust score recalculated.");
    }
  );

  // ------------------------------------------
  // TEST 4: Donor cannot retry payout
  // ------------------------------------------

  await t.test(
    "Rejects payout retry from non-reviewer",
    async () => {
      const response = await retryPayout(
        evidence.id,
        donorToken
      );

      assert.equal(response.status, 403);

      console.log("PASS: Donor cannot retry payout.");
    }
  );

  // ------------------------------------------
  // TEST 5: Reviewer retries a genuinely failed payout
  // ------------------------------------------

  await t.test(
    "Reviewer retries failed payout using original payout and batch ID",
    async () => {
      const retrySuffix = randomUUID();

      // Create a separate approved milestone.
      const retryMilestone = await prisma.milestone.create({
        data: {
          campaignId: campaign.id,
          title: `Retry Test Milestone ${retrySuffix}`,
          budgetAmountCents: 5000,
          status: "approved",
        },
      });

      retryMilestoneId = retryMilestone.id;

      // Create evidence that has already been approved.
      const retryEvidenceRecord =
        await prisma.evidence.create({
          data: {
            milestoneId: retryMilestone.id,
            file: "p5-retry-test-evidence.pdf",
            extractedFields: {},
            aiFindings: {},
            reviewerDecision: "approved",
          },
        });

      retryEvidenceId = retryEvidenceRecord.id;

      retrySenderBatchId = `P5-RETRY-${retrySuffix}`;

      // Simulate a genuine definitive failure.
      // No provider batch ID or submission timestamp exists.
      const failedPayout = await prisma.payout.create({
        data: {
          milestoneId: retryMilestone.id,
          amountCents: 5000,
          senderBatchId: retrySenderBatchId,
          status: "failed",
        },
      });

      retryPayoutId = failedPayout.id;

      // Exercise the actual reviewer HTTP endpoint.
      // Uses the existing retryPayout helper above.
      const response = await retryPayout(
        retryEvidenceId,
        reviewerToken
      );

      const body = await response.json() as {
        message?: string;
        evidenceId?: string;
        milestoneId?: string;
        payout?: {
          id: string;
          status: string;
          senderBatchId: string;
        };
        error?: string;
      };

      assert.equal(
        response.status,
        200,
        JSON.stringify(body)
      );

      assert.equal(body.evidenceId, retryEvidenceId);
      assert.equal(body.milestoneId, retryMilestoneId);
      assert.equal(body.message, "Payout retry accepted");

      assert.ok(body.payout);

      // The original payout record must be reused.
      assert.equal(body.payout.id, retryPayoutId);

      // The original sender batch ID must be preserved.
      assert.equal(
        body.payout.senderBatchId,
        retrySenderBatchId
      );

      assert.equal(body.payout.status, "processing");

      const [savedPayout, payoutCount] = await Promise.all([
        prisma.payout.findUnique({
          where: { id: retryPayoutId },
        }),

        prisma.payout.count({
          where: { milestoneId: retryMilestoneId },
        }),
      ]);

      assert.ok(savedPayout);
      assert.equal(savedPayout.status, "processing");
      assert.equal(
        savedPayout.senderBatchId,
        retrySenderBatchId
      );

      // No second payout record should have been created.
      assert.equal(payoutCount, 1);

      const retryEvents = await prisma.ledgerEvent.findMany({
        where: {
          entityId: retryPayoutId,
        },
        select: {
          type: true,
        },
      });

      assert.ok(
        retryEvents.some(
          (event) => event.type === "PAYOUT_RETRY_STARTED"
        )
      );

      console.log("PASS: Reviewer successfully retried failed payout.");
      console.log("PASS: Original payout record reused.");
      console.log("PASS: Original sender batch ID preserved.");
      console.log("PASS: No duplicate payout created.");
    }
  );

  // ------------------------------------------
  // TEST 6: Processing payout cannot be retried
  // ------------------------------------------

  await t.test(
    "Rejects retry when payout is already processing",
    async () => {
      const response = await retryPayout(
        retryEvidenceId,
        reviewerToken
      );

      const body = await response.json() as {
        error?: string;
        payoutStatus?: string;
      };

      assert.equal(response.status, 409);

      assert.equal(
        body.error,
        "Only failed payouts can be retried"
      );

      assert.equal(body.payoutStatus, "processing");

      const payoutCount = await prisma.payout.count({
        where: {
          milestoneId: retryMilestoneId,
        },
      });

      assert.equal(payoutCount, 1);

      console.log("PASS: Processing payout cannot be retried.");
    }
  );

  // ------------------------------------------
  // TEST 7: No existing payout
  // ------------------------------------------

  await t.test(
    "Rejects retry when no payout exists",
    async () => {
      const noPayoutMilestone = await prisma.milestone.create({
        data: {
          campaignId: campaign.id,
          title: `No Payout Milestone ${randomUUID()}`,
          budgetAmountCents: 3000,
          status: "approved",
          dueDate: new Date(
            Date.now() + 24 * 60 * 60 * 1000
          ),
        },
      });

      const noPayoutEvidence = await prisma.evidence.create({
        data: {
          milestoneId: noPayoutMilestone.id,
          file: "p5-no-payout-test.pdf",
          extractedFields: {},
          aiFindings: {},
          reviewerDecision: "approved",
        },
      });

      const response = await retryPayout(
        noPayoutEvidence.id,
        reviewerToken
      );

      const body = await response.json() as {
        error?: string;
      };

      assert.equal(response.status, 409);

      assert.equal(
        body.error,
        "No existing payout is available to retry"
      );

      const payoutCount = await prisma.payout.count({
        where: {
          milestoneId: noPayoutMilestone.id,
        },
      });

      assert.equal(payoutCount, 0);

      console.log("PASS: Retry cannot create a missing payout.");
    }
  );

  // ------------------------------------------
  // TEST 8: Duplicate approval
  // ------------------------------------------

  await t.test(
    "Prevents duplicate approval and payout",
    async () => {
      const response = await approveEvidence(
        evidence.id,
        reviewerToken
      );

      const body = await response.json() as {
        error?: string;
      };

      assert.equal(response.status, 400);

      assert.equal(
        body.error,
        "Evidence has already been reviewed"
      );

      const payoutCount = await prisma.payout.count({
        where: {
          milestoneId: milestone.id,
        },
      });

      assert.equal(payoutCount, 1);

      console.log(
        "PASS: Duplicate approval did not create another payout."
      );
    }
  );

  // ------------------------------------------
  // TEST 9: Ledger integrity
  // ------------------------------------------

  await t.test(
    "Maintains ledger integrity after approval and retry",
    async () => {
      const result = await verifyChain();

      assert.equal(result.valid, true);

      console.log(
        `PASS: Ledger valid across ${result.checkedEvents} events.`
      );
    }
  );
});
