import { z } from "zod";

// Common validation
const Id = z.string().uuid();
const Money = z.number().int().nonnegative();

export const UserSchema = z.object({
  id: Id,
  role: z.enum(["donor", "organizer", "reviewer"]),
  name: z.string().min(1),
  email: z.string().email(),
});

export const OrganizationSchema = z.object({
  id: Id,
  name: z.string().min(1),
  cause: z.string().min(1),
  location: z.string(),
  verified: z.boolean(),
  trustScore: z.number().int().min(0).max(100),
});

export const CampaignSchema = z.object({
  id: Id,
  organizationId: Id,
  title: z.string().min(1),
  goalAmountCents: Money,
  currency: z.literal("USD"),
  status: z.enum(["draft", "active", "completed", "cancelled"]),
});

export const MilestoneSchema = z.object({
  id: Id,
  campaignId: Id,
  title: z.string().min(1),
  budgetAmountCents: Money,
  status: z.enum([
    "open",
    "evidence_submitted",
    "approved",
    "rejected",
    "paid",
  ]),
});

export const DonationSchema = z.object({
  id: Id,
  campaignId: Id,
  donorId: Id,
  amountCents: z.number().int().positive(),
  paypalOrderId: z.string().nullable(),
  paypalCaptureId: z.string().nullable(),
  status: z.enum(["pending", "completed", "failed", "refunded"]),
});

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

export const PayoutSchema = z.object({
  id: Id,
  milestoneId: Id,
  amountCents: Money,
  senderBatchId: z.string().nullable(),
  paypalBatchId: z.string().nullable(),
  status: z.enum(["pending", "processing", "paid", "failed"]),
});

export const LedgerEventSchema = z.object({
  id: Id,
  type: z.string().min(1),
  entityId: Id,
  payload: z.record(z.string(), z.unknown()),
  prevHash: z.string().nullable(),
  hash: z.string().min(1),
  createdAt: z.string().datetime(),
});

// Export types derived from the schemas
export type User = z.infer<typeof UserSchema>;
export type Organization = z.infer<typeof OrganizationSchema>;
export type Campaign = z.infer<typeof CampaignSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
export type Donation = z.infer<typeof DonationSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Payout = z.infer<typeof PayoutSchema>;
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

