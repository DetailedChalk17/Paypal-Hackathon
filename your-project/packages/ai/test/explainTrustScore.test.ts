import { describe, expect, it } from "vitest";
import { TrustExplanationSchema } from "@your-project/shared";
import { explainTrustScore, TRUST_SYSTEM_PROMPT } from "../src/explainTrustScore";
import { citesOnlyAllowedNumbers, allowedNumbers } from "../src/grounding";
import { fakeProvider } from "./helpers";

// Shaped exactly like the API's calculateTrustScore() output.
const breakdown = {
  version: 1,
  calculatedAt: "2026-11-07T10:00:00.000Z",
  score: 78,
  coveragePercent: 100,
  earnedPoints: 78,
  availablePoints: 100,
  components: {
    approvedWithEvidence: { weight: 40, earnedPoints: 30, numerator: 3, denominator: 4, applicable: true },
    onTimeUpdates: { weight: 20, earnedPoints: 10, numerator: 1, denominator: 2, applicable: true },
    budgetCompliance: { weight: 20, earnedPoints: 20, numerator: 2, denominator: 2, applicable: true },
    completedMilestones: { weight: 20, earnedPoints: 0, numerator: 0, denominator: 0, applicable: false },
  },
};

const modelSays = (items: Array<[string, string]>) => JSON.stringify({ items: items.map(([key, text]) => ({ key, text })) });

describe("explainTrustScore", () => {
  it("classifies in code and uses the model's wording when it cites only input numbers", async () => {
    const { provider, requests } = fakeProvider(modelSays([
      ["approvedWithEvidence", "A reviewer approved 3 of 4 milestones with evidence."],
      ["onTimeUpdates", "Only 1 of 2 updates arrived on time."],
      ["budgetCompliance", "Both campaigns stayed within budget, earning 20 of 20 points."],
    ]));
    const r = await explainTrustScore(breakdown, { provider });
    if (!r.ok) throw new Error(r.reason);
    expect(TrustExplanationSchema.parse(r.data)).toEqual(r.data);
    expect(r.data.source).toBe("model");
    expect(r.data.strengths.map((s) => s.key)).toEqual(["approvedWithEvidence", "budgetCompliance"]);
    expect(r.data.weaknesses.map((s) => s.key)).toEqual(["onTimeUpdates"]);
    expect(requests[0].system).toContain(TRUST_SYSTEM_PROMPT);
  });

  it("skips components that do not apply", async () => {
    const { provider } = fakeProvider(modelSays([]));
    const r = await explainTrustScore(breakdown, { provider });
    if (!r.ok) throw new Error(r.reason);
    const keys = [...r.data.strengths, ...r.data.weaknesses].map((i) => i.key);
    expect(keys).not.toContain("completedMilestones");
  });

  it("rejects a sentence with an invented number and uses the code template for it", async () => {
    const { provider } = fakeProvider(modelSays([
      ["approvedWithEvidence", "75% of milestones were approved, better than 90% of peers."],
      ["onTimeUpdates", "Only 1 of 2 updates arrived on time."],
      ["budgetCompliance", "Stayed within budget on 2 of 2 campaigns."],
    ]));
    const r = await explainTrustScore(breakdown, { provider });
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.source).toBe("template");
    expect(r.data.strengths[0].text).toBe("3 of 4 milestones approved by a reviewer with evidence (30 of 40 points).");
  });

  it("cannot move a weakness into strengths, whatever the model returns", async () => {
    const { provider } = fakeProvider(modelSays([["onTimeUpdates", "Excellent on-time record!"]]));
    const r = await explainTrustScore(breakdown, { provider });
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.weaknesses.map((w) => w.key)).toContain("onTimeUpdates");
  });

  it("still explains the score from code when the model is down, citing only input numbers", async () => {
    const { provider } = fakeProvider(new Error("503"));
    const r = await explainTrustScore(breakdown, { provider });
    if (!r.ok) throw new Error(r.reason);
    expect(r.data.source).toBe("template");
    const allowed = allowedNumbers(JSON.stringify(breakdown));
    for (const i of [...r.data.strengths, ...r.data.weaknesses]) expect(citesOnlyAllowedNumbers(i.text, allowed)).toBe(true);
  });

  it("accepts any component keys", async () => {
    const { provider } = fakeProvider(new Error("down"));
    const r = await explainTrustScore({ score: 50, components: { reviewSpeed: { weight: 10, earnedPoints: 5, numerator: 1, denominator: 2, applicable: true } } }, { provider });
    expect(r.ok && r.data.weaknesses[0].text).toBe("1 of 2 review speed (5 of 10 points).");
  });

  it("rejects a malformed breakdown", async () => {
    expect(await explainTrustScore({ score: 500 } as any, { provider: null })).toEqual({ ok: false, reason: "invalid_output" });
  });
});
