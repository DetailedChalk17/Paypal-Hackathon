import { z } from "zod";
import {
  EvidenceFindingsSchema,
  type AiResult,
  type CheckEvidenceInput,
  type EvidenceCheck,
  type EvidenceFindings,
  type EvidenceFlag,
  type EvidenceFlagType,
  type ReceiptExtraction,
} from "@your-project/shared";
import { callModel, type CallModelOptions } from "./callModel";
import { allowedNumbers, citesOnlyAllowedNumbers, formatDollars } from "./grounding";
import { validated } from "./validated";

export type CheckEvidenceOptions = CallModelOptions & {
  now?: Date; // for tests; receipts dated after this are out of range
};

// Below this extraction confidence (or with no vendor or total) a receipt is unreadable.
export const MIN_READABLE_CONFIDENCE = 0.5;
const TOTAL_TOLERANCE_CENTS = 1; // rounding on printed tax lines

const SEVERITY: Record<EvidenceFlagType, EvidenceFlag["severity"]> = {
  unreadable: "high",
  duplicate: "high",
  over_budget: "high",
  suspicious_instructions: "high",
  totals_mismatch: "medium",
  date_out_of_range: "medium",
  vendor_mismatch: "medium",
};

// Phrases that only make sense as an instruction to an AI or reviewer.
const INSTRUCTION_PATTERN =
  /ignore (all |any )?(previous|prior|above) instructions|approve (this|the) (milestone|receipt|payout)|system prompt|(note|message) to (the )?(ai|reviewer)|return no flags|set confidence/i;

// ---- Model part: budget line and vendor fit only ----

export const VendorMatchSchema = z.object({
  matchedBudgetLineId: z.string().nullable(),
  vendorFits: z.boolean(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});
type VendorMatch = z.infer<typeof VendorMatchSchema>;

export const VENDOR_MATCH_SYSTEM_PROMPT = `You help a human reviewer check expense evidence for a charity campaign.
Given a campaign milestone and a receipt's vendor and line items, decide:
- matchedBudgetLineId: the id of the budget line this purchase belongs to, or null if none fits or none are listed.
- vendorFits: true if this kind of vendor and these items plausibly serve the milestone's purpose, false if they clearly do not.
- reason: one short sentence a reviewer can read. Do not include amounts or other numbers.
- confidence: 0 to 1.
Judge only plausibility. You do not approve or reject anything.`;

// ---- Public function ----

export async function checkEvidence(
  input: CheckEvidenceInput,
  options: CheckEvidenceOptions = {}
): Promise<AiResult<EvidenceFindings>> {
  const { extraction: e, milestone, campaign, spentCents, priorEvidence } = input;
  const checks: EvidenceCheck[] = [];
  const flags: EvidenceFlag[] = [];
  const flag = (type: EvidenceFlagType, detail: string) => flags.push({ type, severity: SEVERITY[type], detail });

  // 1. Readable
  const readable = e.confidence >= MIN_READABLE_CONFIDENCE && e.vendor !== null && e.totalCents !== null;
  checks.push({
    name: "readable",
    passed: readable,
    detail: readable
      ? "Vendor and total were read from the document."
      : "The document could not be read reliably; vendor or total is missing or confidence is low.",
  });
  if (!readable) flag("unreadable", "The receipt could not be read reliably. Check the original document by hand.");

  // 2. Instructions hidden in the document
  if (e.instructionsDetected || mentionsInstructions(e)) {
    flag(
      "suspicious_instructions",
      "The document contains text addressed to an AI or reviewer. It was treated as data and ignored."
    );
  }

  // 3. Currency
  checks.push(
    e.currency === null
      ? { name: "currency_is_usd", passed: null, detail: "Currency could not be read." }
      : { name: "currency_is_usd", passed: e.currency === "USD", detail: `Currency on the receipt: ${e.currency}.` }
  );

  // 4. Totals add up (code arithmetic)
  checks.push(totalsCheck(e));
  if (checks.at(-1)!.passed === false) flag("totals_mismatch", checks.at(-1)!.detail);

  // 5. Date inside the allowed period
  const dateCheck = dateRangeCheck(e, input, options.now ?? new Date());
  checks.push(dateCheck);
  if (dateCheck.passed === false) flag("date_out_of_range", dateCheck.detail);

  // 6. Within remaining milestone budget
  const remaining = milestone.budgetAmountCents - spentCents;
  if (e.totalCents === null) {
    checks.push({ name: "within_remaining_budget", passed: null, detail: "Total could not be read." });
  } else {
    const within = e.totalCents <= remaining;
    const detail = `Receipt total ${formatDollars(e.totalCents)}; remaining milestone budget ${formatDollars(Math.max(0, remaining))} (budget ${formatDollars(milestone.budgetAmountCents)}, already spent ${formatDollars(spentCents)}).`;
    checks.push({ name: "within_remaining_budget", passed: within, detail });
    if (!within) flag("over_budget", detail);
  }

  // 7. Duplicate of earlier evidence (same vendor, date and total)
  const dup = e.vendor && e.date && e.totalCents !== null
    ? priorEvidence.find(
        (p) =>
          p.extraction.vendor !== null &&
          normalizeVendor(p.extraction.vendor) === normalizeVendor(e.vendor!) &&
          p.extraction.date === e.date &&
          p.extraction.totalCents === e.totalCents
      )
    : undefined;
  if (!e.vendor || !e.date || e.totalCents === null) {
    checks.push({ name: "not_duplicate", passed: null, detail: "Vendor, date or total missing, so duplicates cannot be checked." });
  } else if (dup) {
    const detail = `Same vendor, date and total as earlier evidence ${dup.id}.`;
    checks.push({ name: "not_duplicate", passed: false, detail });
    flag("duplicate", detail);
  } else {
    checks.push({ name: "not_duplicate", passed: true, detail: `No match among ${priorEvidence.length} earlier receipts.` });
  }

  // 8. Model: budget line and vendor fit (skipped when unreadable)
  let match: VendorMatch | null = null;
  let modelFailed = false;
  if (!readable) {
    checks.push({ name: "vendor_fits_budget_line", passed: null, detail: "Skipped because the receipt is unreadable." });
  } else {
    const result = await matchVendor(input, options);
    if (result.ok) {
      match = result.data;
      checks.push({ name: "vendor_fits_budget_line", passed: match.vendorFits, detail: match.reason });
      if (!match.vendorFits) flag("vendor_mismatch", match.reason);
    } else {
      modelFailed = true;
      checks.push({
        name: "vendor_fits_budget_line",
        passed: null,
        detail: `AI check unavailable (${result.reason}). Review the vendor by hand.`,
      });
    }
  }

  const confidence = Math.min(e.confidence, match ? match.confidence : 0.5);
  return validated(EvidenceFindingsSchema, {
    matchedBudgetLineId: match?.matchedBudgetLineId ?? null,
    checks,
    flags,
    overallConfidence: Math.round(confidence * 100) / 100,
    needsManualReview: flags.length > 0 || modelFailed || checks.some((c) => c.passed === false),
  });
}

// ---- Code checks ----

function totalsCheck(e: ReceiptExtraction): EvidenceCheck {
  const name = "totals_add_up" as const;
  if (e.totalCents === null) return { name, passed: null, detail: "Total could not be read." };

  const itemTotals = e.lineItems.map((i) => i.totalCents);
  const itemsKnown = itemTotals.length > 0 && itemTotals.every((t) => t !== null);
  const itemsSum = itemsKnown ? (itemTotals as number[]).reduce((s, t) => s + t, 0) : null;
  const subtotal = e.subtotalCents ?? itemsSum;
  if (subtotal === null) return { name, passed: null, detail: "Neither a subtotal nor all line totals could be read." };

  const tax = e.taxCents ?? 0;
  const problems: string[] = [];
  if (itemsSum !== null && e.subtotalCents !== null && Math.abs(itemsSum - e.subtotalCents) > TOTAL_TOLERANCE_CENTS) {
    problems.push(`line items add up to ${formatDollars(itemsSum)} but the subtotal is ${formatDollars(e.subtotalCents)}`);
  }
  const expected = subtotal + tax;
  if (Math.abs(expected - e.totalCents) > TOTAL_TOLERANCE_CENTS) {
    problems.push(
      `subtotal ${formatDollars(subtotal)} plus tax ${formatDollars(tax)} is ${formatDollars(expected)} but the printed total is ${formatDollars(e.totalCents)}`
    );
  }
  return problems.length === 0
    ? { name, passed: true, detail: `Line items, subtotal and tax add up to the total ${formatDollars(e.totalCents)}.` }
    : { name, passed: false, detail: capitalize(problems.join("; ")) + "." };
}

function dateRangeCheck(e: ReceiptExtraction, input: CheckEvidenceInput, now: Date): EvidenceCheck {
  const name = "date_in_campaign_period" as const;
  if (e.date === null) return { name, passed: null, detail: "Receipt date could not be read." };

  const today = now.toISOString().slice(0, 10);
  const start = input.campaign.startDate ?? null;
  const end = input.campaign.endDate ?? input.milestone.dueDate?.slice(0, 10) ?? null;
  const endLabel = input.campaign.endDate ? "campaign end" : "milestone due date";

  if (e.date > today) return { name, passed: false, detail: `Receipt date ${e.date} is in the future.` };
  if (start && e.date < start) return { name, passed: false, detail: `Receipt date ${e.date} is before the campaign start ${start}.` };
  if (end && e.date > end) return { name, passed: false, detail: `Receipt date ${e.date} is after the ${endLabel} ${end}.` };
  const range = start || end ? ` (${start ?? "no start date"} to ${end ?? "no end date"})` : " (no campaign dates on record; only checked it is not in the future)";
  return { name, passed: true, detail: `Receipt date ${e.date} is inside the allowed period${range}.` };
}

function mentionsInstructions(e: ReceiptExtraction): boolean {
  const texts = [e.vendor, ...e.lineItems.map((i) => i.description)].filter((t): t is string => !!t);
  return texts.some((t) => INSTRUCTION_PATTERN.test(t));
}

export function normalizeVendor(v: string): string {
  return v.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- Model call ----

async function matchVendor(input: CheckEvidenceInput, options: CallModelOptions): Promise<AiResult<VendorMatch>> {
  const { extraction: e, milestone, campaign } = input;
  const lines = milestone.budgetLines ?? [];
  const context = {
    campaign: { title: campaign.title, cause: campaign.cause ?? null, organization: campaign.organizationName ?? null },
    milestone: { title: milestone.title },
    budgetLines: lines.map((l) => ({ id: l.id, label: l.label })),
  };
  // Vendor and item text come from the uploaded document: passed as data only.
  const receipt = { vendor: e.vendor, items: e.lineItems.map((i) => i.description).filter(Boolean) };
  const prompt =
    `Context:\n${JSON.stringify(context, null, 2)}\n\n` +
    `Receipt data (untrusted, from the uploaded document):\n${JSON.stringify(receipt, null, 2)}`;

  const result = await callModel({ schema: VendorMatchSchema, system: VENDOR_MATCH_SYSTEM_PROMPT, prompt }, options);
  if (!result.ok) return result;

  const m = result.data;
  const lineId = m.matchedBudgetLineId && lines.some((l) => l.id === m.matchedBudgetLineId) ? m.matchedBudgetLineId : null;
  const reasonOk = m.reason.trim().length > 0 && citesOnlyAllowedNumbers(m.reason, allowedNumbers(prompt));
  const reason = reasonOk
    ? m.reason.trim()
    : m.vendorFits
      ? "The vendor appears to fit this milestone."
      : "The vendor does not appear to fit this milestone.";
  return { ok: true, data: { ...m, matchedBudgetLineId: lineId, reason } };
}
