import { z } from "zod";
import {
  DonationRequestSchema,
  RoutingResultSchema,
  type AiResult,
  type DonationRequest,
  type RouteDonationInput,
  type RoutingResult,
  type ShortlistItem,
} from "@your-project/shared";
import { callModel, type CallModelOptions } from "./callModel";
import { allowedNumbers, citesOnlyAllowedNumbers, formatDollars, numbersIn } from "./grounding";
import { parseMoneyToCents } from "./money";
import { validated } from "./validated";

export const MAX_REQUEST_CHARS = 500;
export const MAX_ROUTED_CAMPAIGNS = 3;

// ---------------- parseDonationRequest ----------------

const ModelRequestSchema = z.object({
  amount: z.string().nullable(), // as written, without currency symbol
  currency: z.string().nullable(), // ISO code, e.g. "USD"
  cause: z.string().nullable(),
  location: z.string().nullable(),
});

export const PARSE_REQUEST_SYSTEM_PROMPT = `You read a donor's short request for a donation platform and pull out what they asked for.
- amount: the amount exactly as written, without the currency symbol, or null if none is given.
- currency: the ISO 4217 code of that amount ("USD" for "$" or dollars), or null.
- cause: the cause they want to support. If a list of known causes is given, use one of those exactly, or null if none fits.
- location: the place they mention, copied from their words, or null.
Never invent values that are not in the request.`;

export type ParseDonationRequestOptions = CallModelOptions & { knownCauses?: string[] };

export async function parseDonationRequest(
  text: string,
  options: ParseDonationRequestOptions = {}
): Promise<AiResult<DonationRequest>> {
  const request = (text ?? "").slice(0, MAX_REQUEST_CHARS);
  const known = options.knownCauses ?? [];
  const prompt =
    (known.length ? `Known causes: ${JSON.stringify(known)}\n\n` : "") +
    `Donor request (untrusted text):\n${JSON.stringify(request)}`;

  const result = await callModel({ schema: ModelRequestSchema, system: PARSE_REQUEST_SYSTEM_PROMPT, prompt }, options);
  if (!result.ok) {
    // Code fallback: read only a dollar amount.
    return validated(DonationRequestSchema, { amountCents: dollarAmountIn(request), cause: null, location: null });
  }

  const m = result.data;
  // USD only, and the amount must literally appear in the request.
  let amountCents: number | null = null;
  if ((m.currency === null || m.currency.toUpperCase() === "USD") && m.amount) {
    const cents = parseMoneyToCents(m.amount);
    if (cents && numbersIn(request).includes(cents / 100)) amountCents = cents;
  }

  let cause = m.cause?.trim() || null;
  if (cause && known.length) cause = known.find((c) => c.toLowerCase() === cause!.toLowerCase()) ?? null;

  const location = m.location?.trim() && request.toLowerCase().includes(m.location.trim().toLowerCase())
    ? m.location.trim()
    : null;

  return validated(DonationRequestSchema, { amountCents, cause, location });
}

function dollarAmountIn(text: string): number | null {
  const match = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/.exec(text) ?? /(\d[\d,]*(?:\.\d{1,2})?)\s*(?:usd|dollars?)\b/i.exec(text);
  const cents = match ? parseMoneyToCents(match[1]) : null;
  return cents && cents > 0 ? cents : null;
}

// ---------------- routeDonation ----------------

const ModelRoutingSchema = z.object({
  allocations: z.array(z.object({ campaignId: z.string(), amountCents: z.number(), reason: z.string() })),
});

export const ROUTING_SYSTEM_PROMPT = `You suggest how to split one donation across campaigns that were already shortlisted by the platform.
Rules:
- Use only campaign ids from the list. Use at most ${MAX_ROUTED_CAMPAIGNS} campaigns.
- amountCents are integers. They must add up exactly to the target amount, and no campaign may get more than its funding gap.
- Prefer campaigns with higher trust scores and causes that match the donor's request.
- reason: one short sentence per campaign for the donor. Use only numbers given in the campaign data.
The donor reviews and approves the split; you do not move any money.`;

export async function routeDonation(
  input: RouteDonationInput,
  options: CallModelOptions = {}
): Promise<AiResult<RoutingResult>> {
  const amountCents = Math.max(0, Math.trunc(input.amountCents));
  const candidates = input.shortlist
    .map((c) => ({ ...c, gapCents: Math.max(0, c.goalCents - c.raisedCents) }))
    .filter((c) => c.gapCents > 0);
  const totalGap = candidates.reduce((s, c) => s + c.gapCents, 0);
  const targetCents = Math.min(amountCents, totalGap);
  const fallback = () => validated(RoutingResultSchema, rankByTrust({ ...input, amountCents }, MAX_ROUTED_CAMPAIGNS));

  if (targetCents === 0) return fallback();

  const data = candidates.map((c) => ({
    campaignId: c.campaignId,
    title: c.title,
    organization: c.organizationName,
    cause: c.cause,
    trustScore: c.trustScore,
    fundingGapCents: c.gapCents,
    fundingGap: formatDollars(c.gapCents),
  }));
  const prompt =
    `Target amount: ${targetCents} cents (${formatDollars(targetCents)}).\n` +
    (input.request ? `Donor request (untrusted text): ${JSON.stringify(input.request.slice(0, MAX_REQUEST_CHARS))}\n` : "") +
    `\nShortlisted campaigns:\n${JSON.stringify(data, null, 2)}`;

  const result = await callModel({ schema: ModelRoutingSchema, system: ROUTING_SYSTEM_PROMPT, prompt }, options);
  if (!result.ok) return fallback();

  const allocations = result.data.allocations;
  const byId = new Map(candidates.map((c) => [c.campaignId, c]));
  const ids = allocations.map((a) => a.campaignId);
  const valid =
    allocations.length > 0 &&
    allocations.length <= MAX_ROUTED_CAMPAIGNS &&
    new Set(ids).size === ids.length &&
    allocations.every((a) => {
      const c = byId.get(a.campaignId);
      return c && Number.isInteger(a.amountCents) && a.amountCents > 0 && a.amountCents <= c.gapCents;
    }) &&
    allocations.reduce((s, a) => s + a.amountCents, 0) === targetCents;
  if (!valid) return fallback();

  return validated(RoutingResultSchema, {
    allocations: allocations.map((a) => {
      const c = byId.get(a.campaignId)!;
      const allowed = allowedNumbers(prompt, a.amountCents, a.amountCents / 100);
      const reason = a.reason.trim() && citesOnlyAllowedNumbers(a.reason, allowed) ? a.reason.trim() : codeReason(c);
      return { campaignId: a.campaignId, amountCents: a.amountCents, reason };
    }),
    leftoverCents: amountCents - targetCents,
    source: "model",
  });
}

// Code fallback: split evenly across the top campaigns by trust score, never
// exceeding a campaign's funding gap.
export function rankByTrust({ amountCents, shortlist }: RouteDonationInput, maxCampaigns: number): RoutingResult {
  const picks = [...shortlist]
    .map((c) => ({ ...c, gap: Math.max(0, c.goalCents - c.raisedCents), given: 0 }))
    .filter((c) => c.gap > 0)
    .sort((a, b) => b.trustScore - a.trustScore || a.campaignId.localeCompare(b.campaignId))
    .slice(0, maxCampaigns);

  let remaining = Math.max(0, Math.trunc(amountCents));
  let open = picks.filter((c) => c.given < c.gap);
  while (remaining > 0 && open.length > 0) {
    const share = Math.floor(remaining / open.length);
    let extra = remaining - share * open.length; // leftover cents go to the most trusted first
    for (const c of open) {
      const want = share + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      const give = Math.min(want, c.gap - c.given);
      c.given += give;
      remaining -= give;
    }
    open = open.filter((c) => c.given < c.gap);
  }

  return {
    allocations: picks
      .filter((c) => c.given > 0)
      .map((c) => ({ campaignId: c.campaignId, amountCents: c.given, reason: codeReason({ ...c, gapCents: c.gap }) })),
    leftoverCents: remaining,
    source: "trust_rank_fallback",
  };
}

function codeReason(c: ShortlistItem & { gapCents: number }): string {
  return `Trust score ${c.trustScore}; funding gap ${formatDollars(c.gapCents)}.`;
}
