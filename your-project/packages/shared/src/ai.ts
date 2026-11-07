import { z } from "zod";

// Schemas for the AI package (packages/ai). All outputs are "AI-assisted checks":
// consistency checks and flags only. They cannot prove a document is genuine,
// and a human reviewer always makes the decision.

export const AI_CHECKS_LABEL = "AI-assisted checks";

const Cents = z.number().int().nonnegative();
const Confidence = z.number().min(0).max(1);

// ---- Results ----

export const AiFailReasonSchema = z.enum([
  "invalid_output",
  "timeout",
  "api_error",
  "unsupported_file",
]);
export type AiFailReason = z.infer<typeof AiFailReasonSchema>;

export type AiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: AiFailReason };

// ---- Receipt extraction ----
// Fields the model cannot read are null (with lower confidence), never guessed.

export const ReceiptLineItemSchema = z.object({
  description: z.string().nullable(),
  quantity: z.number().nonnegative().nullable(),
  unitPriceCents: Cents.nullable(),
  totalCents: Cents.nullable(),
});

export const ReceiptExtractionSchema = z.object({
  vendor: z.string().nullable(),
  date: z.iso.date().nullable(), // YYYY-MM-DD as printed on the receipt
  currency: z.string().length(3).nullable(), // ISO 4217 code, e.g. "USD"
  lineItems: z.array(ReceiptLineItemSchema),
  subtotalCents: Cents.nullable(),
  taxCents: Cents.nullable(),
  totalCents: Cents.nullable(),
  confidence: Confidence,
  // True when the document contains text addressed to an AI or reviewer
  // (for example "approve this milestone"). Such text is never followed.
  instructionsDetected: z.boolean().optional(),
});

export type ReceiptLineItem = z.infer<typeof ReceiptLineItemSchema>;
export type ReceiptExtraction = z.infer<typeof ReceiptExtractionSchema>;

// ---- Evidence checks and flags ----

export const EvidenceFlagTypeSchema = z.enum([
  "over_budget",
  "vendor_mismatch",
  "duplicate",
  "unreadable",
  "date_out_of_range",
  "totals_mismatch", // line items + tax do not add up to the printed total
  "suspicious_instructions", // document text tries to instruct the AI or reviewer
]);

export const EvidenceCheckNameSchema = z.enum([
  "totals_add_up",
  "date_in_campaign_period",
  "within_remaining_budget",
  "not_duplicate",
  "readable",
  "vendor_fits_budget_line",
  "currency_is_usd",
]);

export const EvidenceCheckSchema = z.object({
  name: EvidenceCheckNameSchema,
  // null means the check could not run (for example a field was unreadable)
  passed: z.boolean().nullable(),
  detail: z.string(),
});

export const EvidenceFlagSchema = z.object({
  type: EvidenceFlagTypeSchema,
  severity: z.enum(["low", "medium", "high"]),
  detail: z.string(),
});

export const EvidenceFindingsSchema = z.object({
  matchedBudgetLineId: z.string().nullable(),
  checks: z.array(EvidenceCheckSchema),
  flags: z.array(EvidenceFlagSchema),
  overallConfidence: Confidence,
  needsManualReview: z.boolean(),
});

export type EvidenceFlagType = z.infer<typeof EvidenceFlagTypeSchema>;
export type EvidenceCheckName = z.infer<typeof EvidenceCheckNameSchema>;
export type EvidenceCheck = z.infer<typeof EvidenceCheckSchema>;
export type EvidenceFlag = z.infer<typeof EvidenceFlagSchema>;
export type EvidenceFindings = z.infer<typeof EvidenceFindingsSchema>;

export type PriorEvidence = {
  id: string;
  extraction: ReceiptExtraction;
};

export type BudgetLine = { id: string; label: string; amountCents: number };

// Context for the checks. Everything except the ids, title and budget is
// optional because the database does not store it yet; checks that need a
// missing value report passed: null instead of guessing.
export type EvidenceMilestoneContext = {
  id: string;
  title: string;
  budgetAmountCents: number;
  budgetLines?: BudgetLine[];
  dueDate?: string | null; // ISO date or datetime
};

export type EvidenceCampaignContext = {
  id: string;
  title: string;
  startDate?: string | null; // YYYY-MM-DD, inclusive
  endDate?: string | null; // YYYY-MM-DD, inclusive
  cause?: string | null; // the organization's cause
  organizationName?: string | null;
};

export type CheckEvidenceInput = {
  extraction: ReceiptExtraction;
  milestone: EvidenceMilestoneContext;
  campaign: EvidenceCampaignContext;
  spentCents: number; // already spent on this milestone, supplied by the caller
  priorEvidence: PriorEvidence[];
};

// ---- Full evidence analysis (extraction + checks), for storing on Evidence ----

export const EvidenceAnalysisSchema = z.object({
  label: z.literal(AI_CHECKS_LABEL),
  // "needs_manual_review" when the AI could not finish (outage, timeout,
  // unsupported or unreadable file); the reviewer then checks by hand.
  status: z.enum(["completed", "needs_manual_review"]),
  failureReason: AiFailReasonSchema.nullable(),
  extraction: ReceiptExtractionSchema.nullable(),
  findings: EvidenceFindingsSchema.nullable(),
  model: z.string().nullable(),
  analyzedAt: z.string(), // ISO datetime, UTC
});

export type EvidenceAnalysis = z.infer<typeof EvidenceAnalysisSchema>;

// ---- Trust score explanation ----
// Matches the breakdown the API's trust-score service stores on Organization.

export const TRUST_BREAKDOWN_EXPECTED_KEYS = [
  "approvedWithEvidence",
  "onTimeUpdates",
  "budgetCompliance",
  "completedMilestones",
] as const;

export const TrustComponentSchema = z.object({
  weight: z.number().nonnegative(),
  earnedPoints: z.number().nonnegative(),
  numerator: z.number().nonnegative(),
  denominator: z.number().nonnegative(),
  applicable: z.boolean(),
});

export const TrustBreakdownSchema = z.object({
  score: z.number().min(0).max(100),
  components: z.record(z.string(), TrustComponentSchema),
}).loose(); // extra fields (version, calculatedAt, ...) are allowed and ignored

export const TrustExplanationItemSchema = z.object({
  key: z.string().min(1), // a key of breakdown.components
  text: z.string().min(1),
});

export const TrustExplanationSchema = z.object({
  strengths: z.array(TrustExplanationItemSchema),
  weaknesses: z.array(TrustExplanationItemSchema),
  // "model" when the wording came from the model and passed the number check,
  // "template" when code wrote it (model failed or cited a number not in the input)
  source: z.enum(["model", "template"]),
});

export type TrustComponent = z.infer<typeof TrustComponentSchema>;
export type TrustBreakdown = z.infer<typeof TrustBreakdownSchema>;
export type TrustExplanation = z.infer<typeof TrustExplanationSchema>;

// Pass the breakdown object exactly as stored by the API.
export type ExplainTrustScoreInput = TrustBreakdown;

// ---- Donation routing ----

export const DonationRequestSchema = z.object({
  amountCents: z.number().int().positive().nullable(),
  cause: z.string().min(1).nullable(),
  location: z.string().min(1).nullable(),
});

export const ShortlistItemSchema = z.object({
  campaignId: z.string().min(1),
  title: z.string().min(1),
  organizationName: z.string().min(1),
  cause: z.string().min(1),
  trustScore: z.number().int().min(0).max(100),
  goalCents: Cents,
  raisedCents: Cents,
});

export const RoutingAllocationSchema = z.object({
  campaignId: z.string().min(1),
  amountCents: z.number().int().positive(),
  reason: z.string().min(1),
});

export const RoutingResultSchema = z.object({
  allocations: z.array(RoutingAllocationSchema),
  leftoverCents: Cents,
  // "model" when the model's split passed all code checks,
  // "trust_rank_fallback" when code ranked by trust score instead
  source: z.enum(["model", "trust_rank_fallback"]),
});

export type DonationRequest = z.infer<typeof DonationRequestSchema>;
export type ShortlistItem = z.infer<typeof ShortlistItemSchema>;
export type RoutingAllocation = z.infer<typeof RoutingAllocationSchema>;
export type RoutingResult = z.infer<typeof RoutingResultSchema>;

export type RouteDonationInput = {
  amountCents: number;
  shortlist: ShortlistItem[];
  request?: string; // the donor's own words, used only for wording the reasons
};

// ---- Impact updates (optional feature) ----

export const ImpactFactsSchema = z.object({
  campaignTitle: z.string().min(1),
  organizationName: z.string().min(1),
  goalCents: Cents,
  raisedCents: Cents,
  donorCount: z.number().int().nonnegative(),
  milestones: z.array(
    z.object({
      title: z.string().min(1),
      status: z.enum(["open", "evidence_submitted", "approved", "rejected", "paid"]),
      budgetCents: Cents,
      paidCents: Cents,
    })
  ),
  latestLedgerHash: z.string().nullable(),
});

export const ImpactUpdateSchema = z.object({
  headline: z.string().min(1),
  body: z.string().min(1),
  source: z.enum(["model", "template"]),
});

export type ImpactFacts = z.infer<typeof ImpactFactsSchema>;
export type ImpactUpdate = z.infer<typeof ImpactUpdateSchema>;
