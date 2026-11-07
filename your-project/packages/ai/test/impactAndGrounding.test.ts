import { describe, expect, it } from "vitest";
import { ImpactUpdateSchema, type ImpactFacts } from "@your-project/shared";
import { draftImpactUpdate } from "../src/impactUpdate";
import { allowedNumbers, citesOnlyAllowedNumbers, numbersIn } from "../src/grounding";
import { fakeProvider } from "./helpers";

describe("grounding", () => {
  it("normalizes numbers so formatting does not matter", () => {
    expect(numbersIn("Raised $1,234.50 of 2,000.00, 3 of 4 (75%)")).toEqual([1234.5, 2000, 3, 4, 75]);
    const allowed = allowedNumbers("goal $2,000.00", 3);
    expect(citesOnlyAllowedNumbers("2000 dollars, 3 times", allowed)).toBe(true);
    expect(citesOnlyAllowedNumbers("2001 dollars", allowed)).toBe(false);
    expect(citesOnlyAllowedNumbers("no numbers here", allowed)).toBe(true);
  });
});

const facts: ImpactFacts = {
  campaignTitle: "Robots for Riverside",
  organizationName: "Riverside Youth Robotics Club",
  goalCents: 270_000,
  raisedCents: 182_550,
  donorCount: 41,
  milestones: [
    { title: "Build two robots", status: "paid", budgetCents: 120_000, paidCents: 120_000 },
    { title: "Regional competition", status: "evidence_submitted", budgetCents: 90_000, paidCents: 0 },
  ],
  latestLedgerHash: "ab12",
};

describe("draftImpactUpdate", () => {
  it("uses the model's text when every number comes from the facts", async () => {
    const { provider } = fakeProvider(JSON.stringify({
      headline: "Two robots built, competition next",
      body: "41 donors have given $1,825.50 toward a $2,700.00 goal. The robot build is verified and paid ($1,200.00). Competition travel is waiting for review.",
    }));
    const r = await draftImpactUpdate(facts, { provider });
    if (!r.ok) throw new Error(r.reason);
    expect(ImpactUpdateSchema.parse(r.data)).toEqual(r.data);
    expect(r.data.source).toBe("model");
  });

  it("falls back to a code template when the model invents a figure", async () => {
    const { provider } = fakeProvider(JSON.stringify({ headline: "68% funded!", body: "200 students reached." }));
    const r = await draftImpactUpdate(facts, { provider });
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.source).toBe("template");
    expect(r.data.body).toContain("$1,825.50 of its $2,700.00 goal from 41 donors");
    expect(r.data.body).toContain("Verified and paid: Build two robots ($1,200.00)");
    expect(r.data.body).toContain("Still pending: Regional competition");
  });

  it("falls back to the template on an outage and rejects malformed facts", async () => {
    const { provider } = fakeProvider(new Error("503"));
    const r = await draftImpactUpdate(facts, { provider });
    expect(r.ok && r.data.source).toBe("template");
    expect(await draftImpactUpdate({ ...facts, goalCents: -1 }, { provider: null })).toEqual({ ok: false, reason: "invalid_output" });
  });
});
