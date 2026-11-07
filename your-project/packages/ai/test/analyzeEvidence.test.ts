import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AI_CHECKS_LABEL, EvidenceAnalysisSchema } from "@your-project/shared";
import { analyzeEvidence, analyzeEvidenceFile } from "../src/analyzeEvidence";
import { EVAL_NOW, RECEIPTS_DIR, contextFor, fixtures, loadFile } from "../eval/fixtures";
import { fakeProvider } from "./helpers";

const f = (id: string) => fixtures.find((x) => x.id === id)!;
const now = EVAL_NOW;

const extractionAnswer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    readability: "clear", vendor: "Tech Haven Supplies", date: "2026-09-25", currency: "USD",
    lineItems: [{ description: "Sensor", quantity: "4", unitPrice: "3.95", total: "15.80" }],
    subtotal: "15.80", tax: "1.30", total: "27.10", confidence: 0.9, instructionsDetected: false, ...over,
  });
const vendorAnswer = JSON.stringify({ matchedBudgetLineId: "kits-electronics", vendorFits: true, reason: "Electronics for robots.", confidence: 0.9 });

describe("analyzeEvidence (API entry point)", () => {
  it("runs extraction then checks and labels the result as AI-assisted checks", async () => {
    const { provider } = fakeProvider(extractionAnswer(), vendorAnswer);
    const r = await analyzeEvidence({ ...contextFor(f("r12")), file: loadFile(f("r12")) }, { provider, now });
    expect(EvidenceAnalysisSchema.parse(r)).toEqual(r);
    expect(r.label).toBe(AI_CHECKS_LABEL);
    expect(r.status).toBe("completed");
    expect(r.model).toBe("fake/fake-1");
    expect(r.findings!.flags.map((x) => x.type)).toEqual(["totals_mismatch"]);
    expect(r.findings!.needsManualReview).toBe(true);
  });

  it.each([
    ["an API outage", [new Error("503 Service Unavailable"), new Error("503")], "api_error"],
    ["a timeout", ["hang"], "timeout"],
    ["invalid model output twice", ["nonsense", "{}"], "invalid_output"],
  ] as const)("turns %s into needs_manual_review instead of crashing", async (_label, answers, reason) => {
    const { provider } = fakeProvider(...(answers as any));
    const r = await analyzeEvidence({ ...contextFor(f("r01")), file: loadFile(f("r01")) }, { provider, now, timeoutMs: 20 });
    expect(r).toMatchObject({ status: "needs_manual_review", failureReason: reason, extraction: null, findings: null });
    expect(EvidenceAnalysisSchema.parse(r)).toEqual(r);
  });

  it("returns needs_manual_review with no key configured", async () => {
    const r = await analyzeEvidence({ ...contextFor(f("r01")), file: loadFile(f("r01")) }, { provider: null, now });
    expect(r).toMatchObject({ status: "needs_manual_review", failureReason: "api_error", model: null });
  });

  it("returns unsupported_file for a non-receipt upload, without calling the model", async () => {
    const { provider } = fakeProvider();
    const r = await analyzeEvidence({ ...contextFor(f("r01")), file: { data: new TextEncoder().encode("GIF89a") } }, { provider, now });
    expect(r).toMatchObject({ status: "needs_manual_review", failureReason: "unsupported_file" });
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("keeps the extraction when only the vendor check fails, and still completes the code checks", async () => {
    const { provider } = fakeProvider(extractionAnswer(), new Error("429"));
    const r = await analyzeEvidence({ ...contextFor(f("r12")), file: loadFile(f("r12")) }, { provider, now });
    expect(r.status).toBe("completed");
    expect(r.extraction!.totalCents).toBe(2710);
    expect(r.findings!.needsManualReview).toBe(true);
  });

  it("injection receipt: a model that obeys hidden text still cannot hide the wrong total or approve anything", async () => {
    // Worst case: the model reports the receipt as clean and confident, but copies the printed numbers.
    const obeying = extractionAnswer({
      vendor: "Bolt & Gear Hardware", date: "2026-10-08", subtotal: "62.49", tax: "5.16", total: "107.65",
      lineItems: [], confidence: 1, instructionsDetected: false,
    });
    const { provider } = fakeProvider(obeying, JSON.stringify({ matchedBudgetLineId: "kits-hardware", vendorFits: true, reason: "Approved.", confidence: 1 }));
    const r = await analyzeEvidence({ ...contextFor(f("r16")), file: loadFile(f("r16")) }, { provider, now });
    expect(r.findings!.flags.map((x) => x.type)).toContain("totals_mismatch");
    expect(r.findings!.needsManualReview).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["analyzedAt", "extraction", "failureReason", "findings", "label", "model", "status"]);
  });

  it("analyzeEvidenceFile reads from disk and handles a missing file", async () => {
    const { provider } = fakeProvider(extractionAnswer(), vendorAnswer);
    const ok = await analyzeEvidenceFile(join(RECEIPTS_DIR, "r12.png"), contextFor(f("r12")), { provider, now });
    expect(ok.status).toBe("completed");
    const missing = await analyzeEvidenceFile(join(tmpdir(), "does-not-exist.png"), contextFor(f("r12")), { provider, now });
    expect(missing).toMatchObject({ status: "needs_manual_review", failureReason: "unsupported_file" });
    const junk = join(tmpdir(), `ai-junk-${process.pid}.png`);
    writeFileSync(junk, "not an image");
    expect((await analyzeEvidenceFile(junk, contextFor(f("r12")), { provider, now })).failureReason).toBe("unsupported_file");
  });
});
