import {
  DonationRequestSchema,
  EvidenceFindingsSchema,
  ReceiptExtractionSchema,
  RoutingResultSchema,
  TrustExplanationSchema,
  type AiResult,
  type CheckEvidenceInput,
  type DonationRequest,
  type EvidenceFindings,
  type ExplainTrustScoreInput,
  type ReceiptExtraction,
  type RouteDonationInput,
  type RoutingResult,
  type TrustExplanation,
} from "@your-project/shared";
import { checkReceiptFile, type ReceiptFile } from "./files";
import { validated } from "./validated";

// STUBS (step 0). Same signatures and schemas as the real functions, returning
// realistic canned data so the API and frontend can integrate now. Each one is
// replaced by its real implementation in steps A3 to A6.

export async function extractReceipt(file: ReceiptFile): Promise<AiResult<ReceiptExtraction>> {
  const check = checkReceiptFile(file);
  if (!check.ok) return check;

  return validated(ReceiptExtractionSchema, {
    vendor: "Greenleaf Office Supply",
    date: "2026-10-12",
    currency: "USD",
    lineItems: [
      { description: "A4 paper, 500 sheets", quantity: 4, unitPriceCents: 649, totalCents: 2596 },
      { description: "Whiteboard markers (12 pack)", quantity: 2, unitPriceCents: 1199, totalCents: 2398 },
    ],
    subtotalCents: 4994,
    taxCents: 412,
    totalCents: 5406,
    confidence: 0.92,
  });
}

export async function checkEvidence(input: CheckEvidenceInput): Promise<AiResult<EvidenceFindings>> {
  const line = input.milestone.budgetLines?.[0] ?? null;

  return validated(EvidenceFindingsSchema, {
    matchedBudgetLineId: line?.id ?? null,
    checks: [
      { name: "readable", passed: true, detail: "Vendor, date and total were read from the receipt." },
      { name: "totals_add_up", passed: true, detail: "Line items plus tax equal the receipt total." },
      { name: "date_in_campaign_period", passed: true, detail: "Receipt date is inside the campaign period." },
      { name: "within_remaining_budget", passed: true, detail: "Amount fits the remaining milestone budget." },
      { name: "not_duplicate", passed: true, detail: "No earlier evidence has the same vendor, date and total." },
      {
        name: "vendor_fits_budget_line",
        passed: line ? true : null,
        detail: line ? `Vendor type fits budget line "${line.label}".` : "Milestone has no budget lines to match.",
      },
    ],
    flags: [],
    overallConfidence: 0.88,
    needsManualReview: false,
  });
}

export async function explainTrustScore(input: ExplainTrustScoreInput): Promise<AiResult<TrustExplanation>> {
  // Template text built only from the input numbers.
  const strengths: TrustExplanation["strengths"] = [];
  const weaknesses: TrustExplanation["weaknesses"] = [];
  for (const [key, { points, max }] of Object.entries(input.breakdown ?? {})) {
    const item = { key, text: `${humanize(key)}: ${points} of ${max} points.` };
    (points >= max * 0.75 ? strengths : weaknesses).push(item);
  }
  return validated(TrustExplanationSchema, { strengths, weaknesses });
}

export async function parseDonationRequest(text: string): Promise<AiResult<DonationRequest>> {
  // Only a dollar amount is read for now; cause and location come with step A6.
  const match = /\$\s?(\d{1,7})(?:\.(\d{1,2}))?/.exec(text ?? "");
  const amountCents = match
    ? Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"))
    : null;
  return validated(DonationRequestSchema, {
    amountCents: amountCents && amountCents > 0 ? amountCents : null,
    cause: null,
    location: null,
  });
}

export async function routeDonation(input: RouteDonationInput): Promise<AiResult<RoutingResult>> {
  return validated(RoutingResultSchema, rankByTrust(input, 3));
}

// Splits the amount evenly across the top `maxCampaigns` campaigns by trust
// score, never exceeding a campaign's funding gap. This becomes the code
// fallback used when the model's routing is invalid.
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
      .map((c) => ({
        campaignId: c.campaignId,
        amountCents: c.given,
        reason: `Trust score ${c.trustScore}; funding gap $${(c.gap / 100).toFixed(2)}.`,
      })),
    leftoverCents: remaining,
    source: "trust_rank_fallback",
  };
}

function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
