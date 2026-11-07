import { app } from "../src/server";
import { prisma } from "../src/lib/prisma";
import { verifyChain } from "../src/services/ledger.service";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";

async function run() {
  console.log("==================================================");
  console.log("  ImpactLedger E2E Backend & AI Integration Test  ");
  console.log("==================================================");

  let server: Server;
  let baseUrl: string;

  // 1. Start Server on dynamic port
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        baseUrl = `http://localhost:${address.port}`;
      }
      resolve();
    });
  });

  try {
    console.log(`\n[1/10] Server running at ${baseUrl}`);

    // [Test 1] Health Check
    console.log("\n[2/10] Testing Health Endpoints...");
    const healthRes = await fetch(`${baseUrl}/health`);
    const healthJson = await healthRes.json();
    if (healthRes.status !== 200 || healthJson.status !== "ok") {
      throw new Error(`Health check failed: ${JSON.stringify(healthJson)}`);
    }

    const dbHealthRes = await fetch(`${baseUrl}/health/db`);
    const dbHealthJson = await dbHealthRes.json();
    if (dbHealthRes.status !== 200 || dbHealthJson.database !== "connected") {
      throw new Error(`DB health check failed: ${JSON.stringify(dbHealthJson)}`);
    }
    console.log("  ✔ /health & /health/db passed (API and PostgreSQL connected)");

    // [Test 2] Demo Logins
    console.log("\n[3/10] Testing Authentication (Donor, Organizer, Reviewer)...");
    async function login(role: "donor" | "organizer" | "reviewer") {
      const res = await fetch(`${baseUrl}/auth/demo-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) {
        throw new Error(`Login failed for ${role}: ${JSON.stringify(data)}`);
      }
      return { token: data.token as string, user: data.user };
    }

    const donorAuth = await login("donor");
    const organizerAuth = await login("organizer");
    const reviewerAuth = await login("reviewer");
    console.log(`  ✔ Donor login: ${donorAuth.user.name} (${donorAuth.user.id})`);
    console.log(`  ✔ Organizer login: ${organizerAuth.user.name} (${organizerAuth.user.id})`);
    console.log(`  ✔ Reviewer login: ${reviewerAuth.user.name} (${reviewerAuth.user.id})`);

    // [Test 3] Organizations & Marketplace
    console.log("\n[4/10] Testing Organizations Marketplace & Trust Scores...");
    const orgsRes = await fetch(`${baseUrl}/organizations`);
    const orgsData = await orgsRes.json();
    const orgsList = orgsData.organizations;
    if (!orgsRes.ok || !Array.isArray(orgsList) || orgsList.length === 0) {
      throw new Error(`Failed to fetch organizations marketplace: ${JSON.stringify(orgsData)}`);
    }
    console.log(`  ✔ Found ${orgsList.length} organizations in marketplace (total: ${orgsData.pagination?.total})`);
    console.log(`    Top organization: "${orgsList[0].name}" with Trust Score: ${orgsList[0].trustScore}/100`);

    const targetOrg = orgsList[0];

    // [Test 4] Recalculate & AI Trust Score Explanation
    console.log("\n[5/10] Recalculating Trust Score & Testing AI Explanation...");
    // Recalculate as reviewer to populate full breakdown
    const recalcRes = await fetch(`${baseUrl}/organizations/${targetOrg.id}/trust-score/recalculate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${reviewerAuth.token}`,
      },
    });
    const recalcJson = await recalcRes.json();
    if (!recalcRes.ok) {
      throw new Error(`Failed to recalculate trust score: ${JSON.stringify(recalcJson)}`);
    }
    console.log(`  ✔ Trust score recalculated: ${recalcJson.score}/100 (Coverage: ${recalcJson.coveragePercent}%)`);

    const explainRes = await fetch(`${baseUrl}/organizations/${targetOrg.id}/trust-score/explain`);
    const explainJson = await explainRes.json();
    if (!explainRes.ok || !explainJson.ok) {
      console.log("    Explanation fallback response:", explainJson);
      throw new Error("Failed to explain trust score");
    }
    console.log(`  ✔ AI Trust Explanation returned (${explainJson.data.source} mode):`);
    console.log(`    Strengths: ${explainJson.data.strengths.length}`);
    for (const s of explainJson.data.strengths.slice(0, 2)) {
      console.log(`      + ${s.key}: "${s.text}"`);
    }
    if (explainJson.data.weaknesses.length > 0) {
      console.log(`    Weaknesses: ${explainJson.data.weaknesses.length}`);
      for (const w of explainJson.data.weaknesses.slice(0, 1)) {
        console.log(`      - ${w.key}: "${w.text}"`);
      }
    }

    // [Test 5] AI Donation Assistant & Routing
    console.log("\n[6/10] Testing AI Donation Assistant & Routing...");
    const assistantRes = await fetch(`${baseUrl}/donations/assistant`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${donorAuth.token}`,
      },
      body: JSON.stringify({
        prompt: "I want to donate $25 to help environmental restoration",
      }),
    });
    const assistantJson = await assistantRes.json();
    if (!assistantRes.ok || !assistantJson.routing) {
      throw new Error(`Donation assistant failed: ${JSON.stringify(assistantJson)}`);
    }
    console.log("  ✔ AI parsed donor prompt and routed donation:");
    console.log(`    Parsed: amountCents=${assistantJson.parsedRequest?.amountCents}`);
    console.log(`    Routing source: ${assistantJson.routing.source}`);
    console.log(`    Allocations (${assistantJson.routing.allocations.length}):`);
    for (const a of assistantJson.routing.allocations) {
      console.log(`      -> Campaign ${a.campaignId}: $${(a.amountCents / 100).toFixed(2)} ("${a.reason}")`);
    }
    console.log(`    Leftover: $${(assistantJson.routing.leftoverCents / 100).toFixed(2)}`);

    // [Test 6] Milestone Evidence Upload with AI Analysis
    console.log("\n[7/10] Testing Milestone Evidence Upload with AI Receipt Checks...");
    // Find an open milestone belonging to the organizer
    const openMilestone = await prisma.milestone.findFirst({
      where: {
        status: "open",
        campaign: {
          organizerId: organizerAuth.user.id,
        },
      },
      include: {
        campaign: true,
      },
    });

    if (!openMilestone) {
      throw new Error("No open milestone found for demo organizer");
    }
    console.log(`  Found open milestone: "${openMilestone.title}" (ID: ${openMilestone.id}) in Campaign "${openMilestone.campaign.title}"`);

    // Prepare synthetic receipt r01.png
    const receiptPath = path.resolve(__dirname, "../../../scripts/receipts/r01.png");
    const receiptBytes = await readFile(receiptPath);
    const formData = new FormData();
    formData.append("file", new Blob([receiptBytes], { type: "image/png" }), "r01.png");

    const uploadRes = await fetch(`${baseUrl}/milestones/${openMilestone.id}/evidence`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${organizerAuth.token}`,
      },
      body: formData,
    });

    const uploadJson = await uploadRes.json();
    if (uploadRes.status !== 201 || !uploadJson.evidence) {
      throw new Error(`Evidence upload failed: ${JSON.stringify(uploadJson)}`);
    }
    const uploadedEvidence = uploadJson.evidence;
    console.log(`  ✔ Evidence uploaded (ID: ${uploadedEvidence.id})`);
    console.log(`    AI Findings status: ${uploadedEvidence.aiFindings?.status}`);
    console.log(`    AI Checks Label: "${uploadedEvidence.aiFindings?.label}"`);

    // Verify milestone status transition
    const updatedMilestone = await prisma.milestone.findUnique({
      where: { id: openMilestone.id },
    });
    if (updatedMilestone?.status !== "evidence_submitted") {
      throw new Error(`Milestone status should be 'evidence_submitted', got '${updatedMilestone?.status}'`);
    }
    console.log(`  ✔ Milestone status transitioned to 'evidence_submitted'`);

    // [Test 7] Reviewer Queue
    console.log("\n[8/10] Testing Reviewer Queue & Inspection...");
    const queueRes = await fetch(`${baseUrl}/evidence/review-queue`, {
      headers: {
        Authorization: `Bearer ${reviewerAuth.token}`,
      },
    });
    const queueJson = await queueRes.json();
    if (!queueRes.ok || !Array.isArray(queueJson)) {
      throw new Error("Failed to fetch reviewer queue");
    }
    const inQueue = queueJson.find((e: any) => e.id === uploadedEvidence.id);
    if (!inQueue) {
      throw new Error("Uploaded evidence was not found in reviewer queue");
    }
    console.log(`  ✔ Evidence present in Reviewer Queue (${queueJson.length} items waiting)`);
    console.log(`    Reviewer sees AI findings: ${JSON.stringify({
      status: inQueue.aiFindings?.status,
      flagsCount: inQueue.aiFindings?.findings?.flags?.length ?? 0,
      confidence: inQueue.aiFindings?.findings?.overallConfidence ?? "N/A"
    })}`);

    // [Test 8] Reviewer Approval & Ledger Event
    console.log("\n[9/10] Testing Reviewer Approval & Tamper-Evident Ledger Recording...");
    const approveRes = await fetch(`${baseUrl}/evidence/${uploadedEvidence.id}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${reviewerAuth.token}`,
      },
    });
    const approveJson = await approveRes.json();
    if (!approveRes.ok) {
      throw new Error(`Evidence approval failed: ${JSON.stringify(approveJson)}`);
    }
    console.log(`  ✔ Evidence approved by reviewer: ${approveJson.message}`);
    if (approveJson.payout) {
      console.log(`    Payout released: $${(approveJson.payout.amountCents / 100).toFixed(2)} (Status: ${approveJson.payout.status})`);
    }

    // [Test 9] Ledger Chain Cryptographic Verification
    console.log("\n[10/10] Verifying SHA-256 Tamper-Evident Hash Chain...");
    const chainVerification = await verifyChain();
    if (!chainVerification.valid) {
      throw new Error(`Ledger chain is invalid at index ${chainVerification.errorIndex}: ${chainVerification.reason}`);
    }
    console.log(`  ✔ Cryptographic Ledger Chain VALID! Verified ${chainVerification.verifiedEvents} events without tamper.`);
    console.log(`    Latest Event Hash: ${chainVerification.latestHash}`);

    // Check Donor Impact Receipt
    const receiptCheckRes = await fetch(`${baseUrl}/donations/b6000000-0000-4000-8000-000000000001/receipt`);
    const receiptCheckJson = await receiptCheckRes.json();
    if (receiptCheckRes.ok && receiptCheckJson.receipt) {
      console.log("\n  ✔ Donor Impact Receipt check verified:");
      console.log(`    Donation: $${(receiptCheckJson.receipt.amountCents / 100).toFixed(2)}`);
      console.log(`    Milestones allocated: ${receiptCheckJson.receipt.milestoneAllocations.length}`);
      console.log(`    Latest ledger hash cited: ${receiptCheckJson.receipt.latestLedgerHash?.slice(0, 16)}...`);
    }

    console.log("\n==================================================");
    console.log("  ALL INTEGRATION TESTS PASSED PERFECTLY! (10/10) ");
    console.log("==================================================");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error("\n❌ E2E INTEGRATION TEST FAILED:", err);
  process.exit(1);
});
