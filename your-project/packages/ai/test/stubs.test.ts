import { describe, expect, it } from "vitest";
import {
  CampaignSchema,
  EvidenceFindingsSchema,
  MilestoneSchema,
  ReceiptExtractionSchema,
  RoutingResultSchema,
  TrustExplanationSchema,
  type ShortlistItem,
} from "@your-project/shared";
import {
  AI_IMPLEMENTATION,
  callModel,
  checkEvidence,
  explainTrustScore,
  parseDonationRequest,
  routeDonation,
} from "../src";

const extraction = ReceiptExtractionSchema.parse({
  vendor: "Greenleaf Office Supply",
  date: "2026-10-12",
  currency: "USD",
  lineItems: [{ description: "A4 paper", quantity: 4, unitPriceCents: 649, totalCents: 2596 }],
  subtotalCents: 2596,
  taxCents: 214,
  totalCents: 2810,
  confidence: 0.9,
});

const campaign = {
  id: "7c0f6d0e-3f8a-4c49-9a5e-1d2b3c4d5e6f",
  title: "Robotics club kits",
  startDate: "2026-10-01",
  endDate: "2026-12-31",
};
const milestone = {
  id: "0b9a8c7d-6e5f-4a3b-8c1d-2e3f4a5b6c7d",
  title: "Buy supplies",
  budgetAmountCents: 50_000,
  budgetLines: [{ id: "bl-1", label: "Stationery", amountCents: 20_000 }],
};

describe("step 0 stubs", () => {
  it("reports which exports are still stubs", () => {
    expect(AI_IMPLEMENTATION.extractReceipt).toBe("real");
    expect(AI_IMPLEMENTATION.checkEvidence).toBe("stub");
  });

  it("callModel reports api_error when no provider is configured", async () => {
    const r = await callModel({ schema: ReceiptExtractionSchema, system: "s", prompt: "p" }, { provider: null });
    expect(r).toEqual({ ok: false, reason: "api_error" });
  });

  it("checkEvidence returns valid findings and matches a real budget line id", async () => {
    const r = await checkEvidence({ extraction, milestone, campaign, spentCents: 0, priorEvidence: [] });
    if (!r.ok) throw new Error("expected ok");
    expect(EvidenceFindingsSchema.parse(r.data)).toEqual(r.data);
    expect(r.data.matchedBudgetLineId).toBe("bl-1");

    const noLines = await checkEvidence({
      extraction,
      milestone: { ...milestone, budgetLines: undefined },
      campaign,
      spentCents: 0,
      priorEvidence: [],
    });
    if (!noLines.ok) throw new Error("expected ok");
    expect(noLines.data.matchedBudgetLineId).toBeNull();
  });

  it("explainTrustScore ties every item to an input key and cites only input numbers", async () => {
    const breakdown = {
      evidenceApprovalRate: { points: 36, max: 40 },
      onTimeUpdates: { points: 9, max: 20 },
      budgetAdherence: { points: 20, max: 20 },
      pastMilestoneCompletion: { points: 10, max: 20 },
    };
    const r = await explainTrustScore({ score: 75, breakdown });
    if (!r.ok) throw new Error("expected ok");
    expect(TrustExplanationSchema.parse(r.data)).toEqual(r.data);

    const items = [...r.data.strengths, ...r.data.weaknesses];
    expect(items.map((i) => i.key).sort()).toEqual(Object.keys(breakdown).sort());
    const allowed = new Set(["75", ...Object.values(breakdown).flatMap((b) => [String(b.points), String(b.max)])]);
    for (const i of items) {
      for (const n of i.text.match(/\d+(\.\d+)?/g) ?? []) expect(allowed).toContain(n);
    }
    expect(r.data.strengths.map((s) => s.key)).toContain("budgetAdherence");
    expect(r.data.weaknesses.map((s) => s.key)).toContain("onTimeUpdates");
  });

  it("parseDonationRequest reads dollar amounts", async () => {
    expect(await parseDonationRequest("$25 for education")).toEqual({
      ok: true,
      data: { amountCents: 2500, cause: null, location: null },
    });
    const cents = await parseDonationRequest("give $12.5 to clean water");
    expect(cents.ok && cents.data.amountCents).toBe(1250);
    const none = await parseDonationRequest("something for schools");
    expect(none.ok && none.data.amountCents).toBeNull();
  });
});

describe("routeDonation (trust-rank split)", () => {
  const item = (id: string, trustScore: number, goalCents: number, raisedCents: number): ShortlistItem => ({
    campaignId: id,
    title: `Campaign ${id}`,
    organizationName: `Org ${id}`,
    cause: "education",
    trustScore,
    goalCents,
    raisedCents,
  });

  function expectValid(r: Awaited<ReturnType<typeof routeDonation>>, amountCents: number, shortlist: ShortlistItem[]) {
    if (!r.ok) throw new Error("expected ok");
    expect(RoutingResultSchema.parse(r.data)).toEqual(r.data);
    const total = r.data.allocations.reduce((s, a) => s + a.amountCents, 0);
    expect(total + r.data.leftoverCents).toBe(amountCents);
    for (const a of r.data.allocations) {
      const c = shortlist.find((s) => s.campaignId === a.campaignId);
      expect(c).toBeDefined();
      expect(a.amountCents).toBeLessThanOrEqual(c!.goalCents - c!.raisedCents);
    }
    return r.data;
  }

  it("splits across the top three by trust score, extra cents to the most trusted", async () => {
    const shortlist = [item("a", 60, 100_000, 0), item("b", 90, 100_000, 0), item("c", 80, 100_000, 0), item("d", 70, 100_000, 0)];
    const data = expectValid(await routeDonation({ amountCents: 2501, shortlist }), 2501, shortlist);
    expect(data.allocations.map((a) => [a.campaignId, a.amountCents])).toEqual([["b", 834], ["c", 834], ["d", 833]]);
    expect(data.leftoverCents).toBe(0);
  });

  it("respects funding gaps and reports leftover", async () => {
    const shortlist = [item("a", 90, 1_000, 900), item("b", 80, 5_000, 4_500), item("full", 99, 1_000, 1_000)];
    const data = expectValid(await routeDonation({ amountCents: 2_500, shortlist }), 2_500, shortlist);
    expect(data.allocations).toHaveLength(2);
    expect(data.leftoverCents).toBe(1_900);
  });

  it("handles an empty shortlist", async () => {
    const data = expectValid(await routeDonation({ amountCents: 1_000, shortlist: [] }), 1_000, []);
    expect(data).toEqual({ allocations: [], leftoverCents: 1_000, source: "trust_rank_fallback" });
  });
});

describe("shared schema additions are optional", () => {
  it("existing Campaign and Milestone shapes still parse", () => {
    const base = { organizationId: milestone.id, goalAmountCents: 100_000, currency: "USD", status: "active" };
    expect(CampaignSchema.safeParse({ ...base, id: campaign.id, title: campaign.title }).success).toBe(true);
    expect(CampaignSchema.safeParse({ ...base, ...campaign }).success).toBe(true);
    expect(CampaignSchema.safeParse({ ...base, ...campaign, startDate: "Oct 1" }).success).toBe(false);

    const m = { id: milestone.id, campaignId: campaign.id, title: "x", budgetAmountCents: 1, status: "open" };
    expect(MilestoneSchema.safeParse(m).success).toBe(true);
    expect(MilestoneSchema.safeParse({ ...m, budgetLines: milestone.budgetLines }).success).toBe(true);
  });
});
