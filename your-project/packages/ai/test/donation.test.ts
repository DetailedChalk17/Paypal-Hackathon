import { describe, expect, it } from "vitest";
import { RoutingResultSchema, type ShortlistItem } from "@your-project/shared";
import { parseDonationRequest, routeDonation } from "../src/donation";
import { fakeProvider } from "./helpers";

const CAUSES = ["Education", "Healthcare", "Water and Sanitation"];
const reply = (o: object) => JSON.stringify(o);

describe("parseDonationRequest", () => {
  it("reads amount, known cause and location", async () => {
    const { provider } = fakeProvider(reply({ amount: "25", currency: "USD", cause: "education", location: "Pune" }));
    expect(await parseDonationRequest("$25 for education in Pune", { provider, knownCauses: CAUSES })).toEqual({
      ok: true,
      data: { amountCents: 2500, cause: "Education", location: "Pune" },
    });
  });

  it("drops an amount that is not in the text, a non-USD amount, an unknown cause and an invented location", async () => {
    const invented = fakeProvider(reply({ amount: "50", currency: "USD", cause: "Space travel", location: "Mumbai" }));
    expect(await parseDonationRequest("$25 for schools in Pune", { provider: invented.provider, knownCauses: CAUSES })).toEqual({
      ok: true,
      data: { amountCents: null, cause: null, location: null },
    });
    const rupees = fakeProvider(reply({ amount: "500", currency: "INR", cause: null, location: null }));
    const r = await parseDonationRequest("give ₹500", { provider: rupees.provider });
    expect(r.ok && r.data.amountCents).toBeNull();
  });

  it("falls back to reading a dollar amount in code when the model is down", async () => {
    const { provider } = fakeProvider(new Error("503"));
    expect(await parseDonationRequest("Please send $12.50 to clean water", { provider })).toEqual({
      ok: true,
      data: { amountCents: 1250, cause: null, location: null },
    });
  });

  it("treats the request as data and caps its length", async () => {
    const { provider, requests } = fakeProvider(reply({ amount: null, currency: null, cause: null, location: null }));
    await parseDonationRequest("x".repeat(5000), { provider });
    expect(requests[0].prompt).toContain("untrusted");
    expect(requests[0].prompt.length).toBeLessThan(700);
  });
});

describe("routeDonation", () => {
  const item = (id: string, trustScore: number, goalCents: number, raisedCents: number, cause = "Education"): ShortlistItem => ({
    campaignId: id, title: `Campaign ${id}`, organizationName: `Org ${id}`, cause, trustScore, goalCents, raisedCents,
  });
  const shortlist = [item("a", 90, 100_000, 99_000), item("b", 70, 50_000, 0), item("c", 60, 50_000, 0), item("d", 95, 10_000, 10_000)];

  function expectValid(r: Awaited<ReturnType<typeof routeDonation>>, amount: number) {
    if (!r.ok) throw new Error(r.reason);
    expect(RoutingResultSchema.parse(r.data)).toEqual(r.data);
    const sum = r.data.allocations.reduce((s, a) => s + a.amountCents, 0);
    expect(sum + r.data.leftoverCents).toBe(amount);
    for (const a of r.data.allocations) {
      const c = shortlist.find((s) => s.campaignId === a.campaignId)!;
      expect(a.amountCents).toBeLessThanOrEqual(c.goalCents - c.raisedCents);
    }
    return r.data;
  }

  it("accepts a valid model split and keeps grounded reasons", async () => {
    const { provider, requests } = fakeProvider(reply({ allocations: [
      { campaignId: "a", amountCents: 1000, reason: "Trust score 90 and only $10.00 left to fund." },
      { campaignId: "b", amountCents: 1500, reason: "Education campaign with trust score 70." },
    ] }));
    const data = expectValid(await routeDonation({ amountCents: 2500, shortlist, request: "$25 for education" }, { provider }), 2500);
    expect(data.source).toBe("model");
    expect(data.allocations[0].reason).toBe("Trust score 90 and only $10.00 left to fund.");
    expect(requests[0].prompt).not.toContain('"d"'); // fully funded campaigns are not offered
  });

  it.each([
    ["an unknown campaign id", [{ campaignId: "zzz", amountCents: 2500, reason: "x" }]],
    ["amounts that do not add up", [{ campaignId: "b", amountCents: 2000, reason: "x" }]],
    ["more than a campaign's funding gap", [{ campaignId: "a", amountCents: 2500, reason: "x" }]],
    ["a fully funded campaign", [{ campaignId: "d", amountCents: 2500, reason: "x" }]],
    ["the same campaign twice", [{ campaignId: "b", amountCents: 1250, reason: "x" }, { campaignId: "b", amountCents: 1250, reason: "x" }]],
    ["fractional cents", [{ campaignId: "b", amountCents: 2499.5, reason: "x" }, { campaignId: "c", amountCents: 0.5, reason: "x" }]],
  ])("falls back to trust ranking on %s", async (_label, allocations) => {
    const { provider } = fakeProvider(reply({ allocations }));
    const data = expectValid(await routeDonation({ amountCents: 2500, shortlist }, { provider }), 2500);
    expect(data.source).toBe("trust_rank_fallback");
  });

  it("falls back to trust ranking when the model is down", async () => {
    const { provider } = fakeProvider(new Error("503"));
    const data = expectValid(await routeDonation({ amountCents: 2501, shortlist }, { provider }), 2501);
    expect(data.source).toBe("trust_rank_fallback");
    expect(data.allocations.map((a) => [a.campaignId, a.amountCents])).toEqual([["a", 834], ["b", 834], ["c", 833]]);
  });

  it("replaces a reason with an invented number", async () => {
    const { provider } = fakeProvider(reply({ allocations: [{ campaignId: "b", amountCents: 2500, reason: "Helps 300 students." }] }));
    const data = expectValid(await routeDonation({ amountCents: 2500, shortlist }, { provider }), 2500);
    expect(data.allocations[0].reason).toBe("Trust score 70; funding gap $500.00.");
  });

  it("reports leftover when the whole shortlist cannot absorb the amount", async () => {
    const small = [item("a", 90, 1_000, 900)];
    const { provider } = fakeProvider(reply({ allocations: [{ campaignId: "a", amountCents: 100, reason: "Last $1.00 needed." }] }));
    const r = await routeDonation({ amountCents: 2500, shortlist: small }, { provider });
    expect(r.ok && r.data).toMatchObject({ leftoverCents: 2400, source: "model" });
  });

  it("handles an empty shortlist without calling the model", async () => {
    const { provider } = fakeProvider();
    const r = await routeDonation({ amountCents: 1000, shortlist: [] }, { provider });
    expect(r).toEqual({ ok: true, data: { allocations: [], leftoverCents: 1000, source: "trust_rank_fallback" } });
    expect(provider.generate).not.toHaveBeenCalled();
  });
});
