
import { z } from "zod";

// Common validation
const Id = z.string().uuid();
const Money = z.number().int().nonnegative();

// 1. User
export const UserSchema = z.object({
  id: Id,
  role: z.enum(["donor", "organizer", "reviewer"]),
  name: z.string().min(1),
  email: z.string().email(),
});

// 2. Organization
export const OrganizationSchema = z.object({
  id: Id,
  name: z.string().min(1),
  cause: z.string().min(1),
  location: z.string(),
  payoutEmail: z.string().email().nullable(),
  verified: z.boolean(),
  trustScore: z.number().int().min(0).max(100),
});

// 3. Campaign
export const CampaignSchema = z.object({
  id: Id,
  organizationId: Id,
  organizerId: Id.nullable(),
  title: z.string().min(1),
  goalAmountCents: Money,
  currency: z.literal("USD"),
  status: z.enum(["draft", "active", "completed", "cancelled"]),
  // Optional, used by AI evidence checks (UTC calendar dates, inclusive)
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
});

// 4. Milestone
export const MilestoneSchema = z.object({
  id: Id,
  campaignId: Id,
  title: z.string().min(1),
  budgetAmountCents: Money,
  // Optional, used by AI evidence checks to match a receipt to a budget line
  budgetLines: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        amountCents: Money,
      })
    )
    .optional(),
  status: z.enum([
    "open",
    "evidence_submitted",
    "approved",
    "rejected",
    "paid",
  ]),
});

// 5. Donation
export const DonationSchema = z.object({
  id: Id,
  campaignId: Id,
  donorId: Id,
  amountCents: z.number().int().positive(),
  paypalOrderId: z.string().nullable(),
  paypalCaptureId: z.string().nullable(),
  status: z.enum(["pending", "completed", "failed", "refunded"]),
});

// 6. Evidence
export const EvidenceSchema = z.object({
  id: Id,
  milestoneId: Id,
  file: z.string().min(1),
  extractedFields: z.record(z.string(), z.unknown()),
  aiFindings: z.record(z.string(), z.unknown()),
  reviewerDecision: z.enum([
    "pending",
    "approved",
    "rejected",
  ]),
});

// 7. Payout
export const PayoutSchema = z.object({
  id: Id,
  milestoneId: Id,
  amountCents: Money,
  senderBatchId: z.string().nullable(),
  paypalBatchId: z.string().nullable(),
  status: z.enum(["pending", "processing", "paid", "failed"]),
});

// 8. Ledger Event
export const LedgerEventSchema = z.object({
  id: Id,
  type: z.string().min(1),
  entityId: Id,
  payload: z.record(z.string(), z.unknown()),
  prevHash: z.string().nullable(),
  hash: z.string().min(1),
  createdAt: z.string().datetime(),
});

export * from "./ai";

// Export TypeScript types derived from Zod schemas
export type User = z.infer<typeof UserSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type Campaign = z.infer<typeof CampaignSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type Donation = z.infer<typeof DonationSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Payout = z.infer<typeof PayoutSchema>;
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

/* ==========================================
   API REQUEST VALIDATION SCHEMAS
========================================== */

// Create campaign request
export const CreateCampaignInputSchema = z.object({
  organizationId: Id,
  title: z.string().trim().min(1).max(120),
  goalAmountCents: z.number().int().positive(),
}).strict();

// Create milestone request
export const CreateMilestoneInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  budgetAmountCents: z.number().int().positive(),
  dueDate: z.string().datetime({ offset: true }).optional(),
}).strict();

// Export request types
export type CreateCampaignInput =
  z.infer<typeof CreateCampaignInputSchema>;

export type CreateMilestoneInput =
  z.infer<typeof CreateMilestoneInputSchema>;

export const UpdateOrganizationPayoutEmailSchema = z.object({
  payoutEmail: z.string().trim().email(),
}).strict();

export type UpdateOrganizationPayoutEmail =
  z.infer<typeof UpdateOrganizationPayoutEmailSchema>;

export const RoutingSuggestionInputSchema = z.object({
  goal: z.string().trim().min(1).max(240),
  amountCents: z.number().int().positive().max(100_000_000),
}).strict();

export type RoutingSuggestionInput =
  z.infer<typeof RoutingSuggestionInputSchema>;
