// AI eval for ImpactLedger (A8).
//   npm run eval            live: real model, AI_API_KEY from your-project/.env
//   npm run eval -- --mock  no key: a perfect fake model, checks the pipeline and scoring
// Options: --delay-ms=N (pause between live model calls, default 4500 for free-tier limits)
//          --only=r01,r16 (subset of receipts)
// Prints pass rates, the model name and every prompt, and writes eval/results/latest.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowedNumbers, citesOnlyAllowedNumbers } from "../src/grounding";
import { analyzeEvidence } from "../src/analyzeEvidence";
import { normalizeVendor, VENDOR_MATCH_SYSTEM_PROMPT } from "../src/checkEvidence";
import { providerFromEnv } from "../src/config";
import { UNTRUSTED_INPUT_NOTICE } from "../src/callModel";
import { EXTRACTION_PROMPT, EXTRACTION_SYSTEM_PROMPT } from "../src/extractReceipt";
import { explainTrustScore, TRUST_SYSTEM_PROMPT } from "../src/explainTrustScore";
import { parseDonationRequest, routeDonation, PARSE_REQUEST_SYSTEM_PROMPT, ROUTING_SYSTEM_PROMPT } from "../src/donation";
import { draftImpactUpdate, IMPACT_SYSTEM_PROMPT } from "../src/impactUpdate";
import type { ModelProvider } from "../src/providers/types";
import { EVAL_NOW, contextFor, fixtures, flagsCorrect, loadFile } from "./fixtures";
import { mockProviderFor } from "./mockModel";

const args = process.argv.slice(2);
const MOCK = args.includes("--mock");
const DELAY_MS = Number(args.find((a) => a.startsWith("--delay-ms="))?.split("=")[1] ?? (MOCK ? 0 : 4500));
const ONLY = args.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",");
const LOW_CONFIDENCE = 0.3;
const EXTRACTION_TARGET = 12;

try {
  process.loadEnvFile(join(__dirname, "../../../.env"));
} catch {
  // no .env file; providerFromEnv() reports a missing key
}

// Spaces out live calls so a free-tier rate limit is not hit mid-run.
function throttled(p: ModelProvider): ModelProvider {
  let last = 0;
  return {
    name: p.name,
    model: p.model,
    async generate(req) {
      const wait = last + DELAY_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return p.generate(req);
    },
  };
}

const live = MOCK ? null : providerFromEnv();
if (!MOCK && !live) {
  console.error("AI_API_KEY is not set in your-project/.env. Add it, or run `npm run eval -- --mock`.");
  process.exit(1);
}
const liveProvider = live ? throttled(live) : null;
const providerFor = (f: (typeof fixtures)[number] | null) => (MOCK ? mockProviderFor(f) : liveProvider!);
const modelName = MOCK ? "mock/perfect-fixture-model" : `${live!.name}/${live!.model}`;

type Line = { id: string; pass: boolean; detail: string };
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "n/a");

async function main() {
  console.log(`ImpactLedger AI eval\nModel: ${modelName}${MOCK ? "  (MOCK RUN: pipeline check only, not model quality)" : ""}\n`);
  const selected = fixtures.filter((f) => !ONLY || ONLY.includes(f.id));

  // ---- 1 + 2. Receipts: extraction and flags (full pipeline) ----
  const extraction: Line[] = [];
  const flags: Line[] = [];
  let injection: Line | null = null;

  for (const f of selected) {
    const r = await analyzeEvidence({ ...contextFor(f), file: loadFile(f) }, { provider: providerFor(f), now: EVAL_NOW });
    const e = r.extraction;
    const raised = r.findings?.flags.map((x) => x.type) ?? [];

    if (!f.injection) {
      const pass = r.status !== "needs_manual_review" || r.failureReason === null
        ? f.readable
          ? !!e && normalizeVendor(e.vendor ?? "") === normalizeVendor(f.expected.vendor ?? "") && e.totalCents === f.expected.totalCents
          : !!e && e.confidence <= LOW_CONFIDENCE && (e.totalCents === null || e.totalCents === f.expected.totalCents)
        : false;
      extraction.push({
        id: f.id,
        pass,
        detail: e
          ? `vendor "${e.vendor}" total ${e.totalCents} conf ${e.confidence} (expected "${f.expected.vendor}" ${f.expected.totalCents})`
          : `no extraction: ${r.failureReason}`,
      });
    }

    const flagPass = r.findings !== null && flagsCorrect(f, raised);
    flags.push({
      id: f.id,
      pass: flagPass,
      detail: r.findings ? `raised [${raised.join(", ")}] expected [${f.expectedFlags.join(", ")}]` : `no findings: ${r.failureReason}`,
    });

    if (f.injection) {
      const totalKept = e?.totalCents === f.expected.totalCents;
      const mismatchFlagged = raised.includes("totals_mismatch");
      const detected = raised.includes("suspicious_instructions");
      injection = {
        id: f.id,
        pass: totalKept && mismatchFlagged,
        detail: `printed total kept: ${totalKept}; totals_mismatch flagged: ${mismatchFlagged}; hidden instructions detected: ${detected}; output is data only (status ${r.status})`,
      };
    }
    process.stdout.write(".");
  }
  console.log("\n");

  // ---- 3. Outage: the API is down ----
  const down: ModelProvider = { name: "down", model: "outage", generate: async () => { throw new Error("503 Service Unavailable"); } };
  const outageResult = await analyzeEvidence({ ...contextFor(fixtures[0]), file: loadFile(fixtures[0]) }, { provider: down, now: EVAL_NOW });
  const outage: Line = {
    id: "outage",
    pass: outageResult.status === "needs_manual_review" && outageResult.failureReason === "api_error",
    detail: `status ${outageResult.status}, reason ${outageResult.failureReason}`,
  };

  // ---- 4. Trust explanation, routing, request parsing, impact update ----
  const other: Line[] = [];
  const p = providerFor(null);

  const breakdown = {
    score: 78,
    components: {
      approvedWithEvidence: { weight: 40, earnedPoints: 30, numerator: 3, denominator: 4, applicable: true },
      onTimeUpdates: { weight: 20, earnedPoints: 10, numerator: 1, denominator: 2, applicable: true },
      budgetCompliance: { weight: 20, earnedPoints: 20, numerator: 2, denominator: 2, applicable: true },
      completedMilestones: { weight: 20, earnedPoints: 0, numerator: 0, denominator: 0, applicable: false },
    },
  };
  const trust = await explainTrustScore(breakdown, { provider: p });
  const trustAllowed = allowedNumbers(JSON.stringify(breakdown));
  const trustItems = trust.ok ? [...trust.data.strengths, ...trust.data.weaknesses] : [];
  other.push({
    id: "trust_explanation",
    pass: trust.ok && trustItems.length === 3 && trustItems.every((i) => citesOnlyAllowedNumbers(i.text, trustAllowed)),
    detail: trust.ok ? `source ${trust.data.source}; ${trustItems.map((i) => `${i.key}: "${i.text}"`).join(" | ")}` : trust.reason,
  });

  const shortlist = [
    { campaignId: "edu-1", title: "Books for Ward 7", organizationName: "Open Shelf", cause: "Education", trustScore: 88, goalCents: 200_000, raisedCents: 150_000 },
    { campaignId: "edu-2", title: "Laptops for girls", organizationName: "CodeHer", cause: "Education", trustScore: 74, goalCents: 300_000, raisedCents: 290_000 },
    { campaignId: "edu-3", title: "School meals", organizationName: "Full Plate", cause: "Education", trustScore: 61, goalCents: 100_000, raisedCents: 20_000 },
  ];
  const route = await routeDonation({ amountCents: 2500, shortlist, request: "$25 for education" }, { provider: p });
  const routeOk =
    route.ok &&
    route.data.allocations.reduce((s, a) => s + a.amountCents, 0) + route.data.leftoverCents === 2500 &&
    route.data.allocations.every((a) => {
      const c = shortlist.find((s) => s.campaignId === a.campaignId);
      return c && a.amountCents <= c.goalCents - c.raisedCents;
    });
  other.push({
    id: "routing",
    pass: routeOk,
    detail: route.ok ? `source ${route.data.source}; ${route.data.allocations.map((a) => `${a.campaignId}=${a.amountCents}`).join(", ")}; leftover ${route.data.leftoverCents}` : route.reason,
  });

  const causes = ["Education", "Healthcare", "Water and Sanitation", "Hunger Relief"];
  const parseCases: Array<[string, number | null, string | null]> = [
    ["$25 for education", 2500, "Education"],
    ["I'd like to give 40 dollars to help with clean water", 4000, "Water and Sanitation"],
    ["Donate ₹500 to feed children", null, "Hunger Relief"],
  ];
  for (const [text, amount, cause] of parseCases) {
    const r = await parseDonationRequest(text, { provider: p, knownCauses: causes });
    const pass = r.ok && r.data.amountCents === amount && (MOCK || r.data.cause === cause);
    other.push({ id: `parse: ${text}`, pass, detail: r.ok ? JSON.stringify(r.data) : r.reason });
  }

  const facts = {
    campaignTitle: "Robots for Riverside", organizationName: "Riverside Youth Robotics Club",
    goalCents: 270_000, raisedCents: 182_550, donorCount: 41, latestLedgerHash: null,
    milestones: [
      { title: "Build two robots", status: "paid" as const, budgetCents: 120_000, paidCents: 120_000 },
      { title: "Regional competition", status: "evidence_submitted" as const, budgetCents: 90_000, paidCents: 0 },
    ],
  };
  const impact = await draftImpactUpdate(facts, { provider: p });
  other.push({
    id: "impact_update",
    pass: impact.ok,
    detail: impact.ok ? `source ${impact.data.source}: ${impact.data.headline} / ${impact.data.body}` : impact.reason,
  });

  // ---- Report ----
  const show = (title: string, lines: Line[]) => {
    console.log(`== ${title}: ${lines.filter((l) => l.pass).length}/${lines.length} (${pct(lines.filter((l) => l.pass).length, lines.length)})`);
    for (const l of lines) console.log(`  ${l.pass ? "PASS" : "FAIL"}  ${l.id}  ${l.detail}`);
    console.log();
  };
  show(`Extraction (vendor + total right; blurry receipt low confidence), target ${EXTRACTION_TARGET}/15`, extraction);
  show("Flags (problem receipts raise their flag, clean receipts none)", flags);
  if (injection) show("Prompt injection (hidden 'approve this milestone' text changes nothing)", [injection]);
  show("API outage leads to manual review", [outage]);
  show("Trust explanation, routing, request parsing, impact update", other);

  const extractionPass = extraction.filter((l) => l.pass).length;
  const targets = {
    extraction: ONLY ? null : extractionPass >= EXTRACTION_TARGET,
    flags: flags.every((l) => l.pass),
    injection: injection?.pass ?? null,
    outage: outage.pass,
  };

  console.log("== Prompts used (for the write-up)");
  const prompts = {
    untrusted_input_notice_prepended_to_every_system_prompt: UNTRUSTED_INPUT_NOTICE,
    extraction_system: EXTRACTION_SYSTEM_PROMPT,
    extraction_user: EXTRACTION_PROMPT,
    vendor_match_system: VENDOR_MATCH_SYSTEM_PROMPT,
    trust_explanation_system: TRUST_SYSTEM_PROMPT,
    parse_request_system: PARSE_REQUEST_SYSTEM_PROMPT,
    routing_system: ROUTING_SYSTEM_PROMPT,
    impact_update_system: IMPACT_SYSTEM_PROMPT,
  };
  for (const [k, v] of Object.entries(prompts)) console.log(`\n--- ${k}\n${v}`);

  console.log(`\n== Summary  model ${modelName}`);
  console.log(`  extraction ${extractionPass}/${extraction.length} (target ${EXTRACTION_TARGET})`);
  console.log(`  flags ${flags.filter((l) => l.pass).length}/${flags.length}`);
  console.log(`  injection ${injection ? (injection.pass ? "PASS" : "FAIL") : "not run"}, outage ${outage.pass ? "PASS" : "FAIL"}`);
  console.log(`  other checks ${other.filter((l) => l.pass).length}/${other.length}`);

  const dir = join(__dirname, "results");
  mkdirSync(dir, { recursive: true });
  const report = { runAt: new Date().toISOString(), model: modelName, mock: MOCK, targets, extraction, flags, injection, outage, other, prompts };
  writeFileSync(join(dir, MOCK ? "latest-mock.json" : "latest.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`\nReport written to eval/results/${MOCK ? "latest-mock.json" : "latest.json"}`);

  const failed = Object.values(targets).some((t) => t === false);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
