import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CampaignSchema,
  EvidenceFlagTypeSchema,
  MilestoneSchema,
  ReceiptExtractionSchema,
} from "@your-project/shared";
import { MAX_FILE_BYTES, detectFileType } from "../src/files";

// Sanity checks on scripts/receipts so the eval's ground truth can be trusted.
const DIR = join(__dirname, "../../../scripts/receipts");
const data = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8"));
const receipts: any[] = data.receipts;
const byId = new Map(receipts.map((r) => [r.id, r]));
const milestones = new Map<string, any>(data.milestones.map((m: any) => [m.id, m]));

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", pdf: "application/pdf" };

describe("synthetic receipt set", () => {
  it("has 16 receipts: 10 clean, 5 with one problem, 1 injection", () => {
    expect(receipts).toHaveLength(16);
    expect(receipts.filter((r) => !r.problem)).toHaveLength(10);
    expect(receipts.filter((r) => r.problem && !r.injection)).toHaveLength(5);
    expect(receipts.filter((r) => r.injection)).toHaveLength(1);
    expect(new Set(receipts.filter((r) => r.problem && !r.injection).map((r) => r.problem))).toEqual(
      new Set(["blurry", "wrong_total", "duplicate", "vendor_mismatch", "over_budget"])
    );
  });

  it("campaign and milestones match the shared schemas", () => {
    expect(CampaignSchema.pick({ id: true, title: true, startDate: true, endDate: true }).parse(data.campaign)).toEqual(data.campaign);
    for (const m of data.milestones) {
      expect(() => MilestoneSchema.pick({ id: true, title: true, budgetAmountCents: true, budgetLines: true }).parse(m)).not.toThrow();
    }
  });

  it.each(receipts.map((r) => [r.id, r]))("%s: file exists, is an accepted type and under 5 MB", (_id, r) => {
    const bytes = readFileSync(join(DIR, r.file));
    expect(statSync(join(DIR, r.file)).size).toBeLessThanOrEqual(MAX_FILE_BYTES);
    expect(detectFileType(bytes)).toBe(TYPES[r.file.split(".").pop()]);
  });

  it.each(receipts.map((r) => [r.id, r]))("%s: ground truth is valid and consistent with its expected flags", (_id, r) => {
    const e = r.expected;
    expect(() => ReceiptExtractionSchema.parse({ ...e, confidence: 1 })).not.toThrow();
    for (const f of r.expectedFlags) expect(EvidenceFlagTypeSchema.options).toContain(f);

    const items = e.lineItems.reduce((s: number, i: any) => s + i.totalCents, 0);
    expect(items).toBe(e.subtotalCents);
    const addsUp = e.subtotalCents + e.taxCents === e.totalCents;
    expect(addsUp).toBe(!r.expectedFlags.includes("totals_mismatch"));

    const { startDate, endDate } = data.campaign;
    expect(e.date >= startDate && e.date <= endDate).toBe(!r.expectedFlags.includes("date_out_of_range"));

    const m = milestones.get(r.milestoneId);
    expect(m).toBeDefined();
    const over = e.totalCents > m.budgetAmountCents - r.spentCents;
    expect(over).toBe(r.expectedFlags.includes("over_budget"));

    const dup = r.priorEvidenceIds.some((id: string) => {
      const p = byId.get(id).expected;
      return p.vendor === e.vendor && p.date === e.date && p.totalCents === e.totalCents;
    });
    expect(dup).toBe(r.expectedFlags.includes("duplicate"));

    if (r.expectedBudgetLineId !== null) {
      expect(m.budgetLines.map((l: any) => l.id)).toContain(r.expectedBudgetLineId);
    } else {
      expect(r.expectedFlags).toContain("vendor_mismatch");
    }
    expect(r.readable).toBe(!r.expectedFlags.includes("unreadable"));
  });

  it("clean receipts expect no flags; each problem receipt expects exactly one", () => {
    for (const r of receipts) expect(r.expectedFlags).toHaveLength(r.problem ? 1 : 0);
  });

  it("r10 shares a vendor with r01 but is not a duplicate", () => {
    expect(byId.get("r10").expected.vendor).toBe(byId.get("r01").expected.vendor);
    expect(byId.get("r10").expectedFlags).toEqual([]);
  });
});
