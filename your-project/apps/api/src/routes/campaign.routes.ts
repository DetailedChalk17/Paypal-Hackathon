
import { Router } from "express";

import {
  requireAuth,
  requireRole,
} from "../middleware/auth.middleware";

import { prisma } from "../lib/prisma";
import { getNetDonationAmountsCents } from "../services/refund.service";

import {
  CreateCampaignInputSchema,
  CreateMilestoneInputSchema,
} from "@your-project/shared";

import { draftImpactUpdate } from "../services/ai.service";

const router = Router();

// ==========================================
// POST /campaigns
// Create a new campaign (Organizer only)
// ==========================================

router.post(
  "/",
  requireAuth,
  requireRole("organizer"),
  async (req, res) => {
    const parsed = CreateCampaignInputSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid campaign data",
        details: parsed.error.flatten(),
      });
    }

    try {
      const input = parsed.data;

      const organization = await prisma.organization.findUnique({
        where: {
          id: input.organizationId,
        },
      });

      if (!organization) {
        return res.status(404).json({
          error: "Organization not found",
        });
      }

      const campaign = await prisma.campaign.create({
        data: {
          organizationId: input.organizationId,
          title: input.title,
          goalAmountCents: input.goalAmountCents,
          organizerId: req.user!.id,
        },
      });

      return res.status(201).json(campaign);
    } catch (error) {
      console.error("Create campaign error:", error);

      return res.status(500).json({
        error: "Failed to create campaign",
      });
    }
  }
);

// ==========================================
// GET /campaigns
// List all campaigns
// ==========================================

router.get("/", async (_req, res) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      include: {
        organization: true,
        _count: {
          select: {
            milestones: true,
            donations: true,
          },
        },
      },
      orderBy: {
        title: "asc",
      },
    });

    return res.status(200).json(campaigns);
  } catch (error) {
    console.error("List campaigns error:", error);

    return res.status(500).json({
      error: "Failed to fetch campaigns",
    });
  }
});

// ==========================================
// GET /campaigns/:id
// Get campaign details, milestones and totals
// ==========================================

router.get("/:id", async (req, res) => {
  const campaignId = req.params.id;

  if (typeof campaignId !== "string") {
    return res.status(400).json({
      error: "Invalid campaign ID",
    });
  }

  try {
    const campaign = await prisma.campaign.findUnique({
      where: {
        id: campaignId,
      },
      include: {
        organization: true,
        milestones: true,
        donations: {
  where: {
    status: "completed",
  },
  select: {
    id: true,
    amountCents: true,
    status: true,
    paypalCaptureId: true,
  },
},
      },
    });

    if (!campaign) {
      return res.status(404).json({
        error: "Campaign not found",
      });
    }

   const netAmounts = await getNetDonationAmountsCents(
  prisma,
  campaign.donations.map((donation) => ({
    id: donation.id,
    amountCents: donation.amountCents,
    status: donation.status,
    paypalCaptureId: donation.paypalCaptureId,
    currencyCode: campaign.currency,
  }))
);

const raisedAmountCents = campaign.donations.reduce(
  (total, donation) =>
    total + (netAmounts.get(donation.id) ?? 0),
  0
);
    return res.status(200).json({
      ...campaign,
      raisedAmountCents,
      donations: undefined,
    });
  } catch (error) {
    console.error("Get campaign details error:", error);

    return res.status(500).json({
      error: "Failed to fetch campaign",
    });
  }
});

// ==========================================
// POST /campaigns/:id/milestones
// Create a milestone (Organizer only)
//
// Uses a database transaction and campaign-row
// lock to prevent concurrent budget over-allocation.
// ==========================================

router.post(
  "/:id/milestones",
  requireAuth,
  requireRole("organizer"),
  async (req, res) => {
    const campaignId = req.params.id;

    if (typeof campaignId !== "string") {
      return res.status(400).json({
        error: "Invalid campaign ID",
      });
    }

    const parsed = CreateMilestoneInputSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error: "Invalid milestone data",
        details: parsed.error.flatten(),
      });
    }

    try {
      const input = parsed.data;

      const result = await prisma.$transaction(async (tx) => {
        // Lock the campaign row.
        // Other milestone-creation requests for this campaign
        // must wait until this transaction finishes.
        const lockedCampaigns = await tx.$queryRaw<Array<{ id: string }>>`
  SELECT "id"
  FROM "Campaign"
  WHERE "id" = CAST(${campaignId} AS UUID)
  FOR UPDATE
`;

        if (lockedCampaigns.length === 0) {
          return {
            kind: "not_found" as const,
          };
        }

        // Read the campaign and its milestones after acquiring the lock.
        const campaign = await tx.campaign.findUnique({
          where: {
            id: campaignId,
          },
          include: {
            milestones: true,
          },
        });

        if (!campaign) {
          return {
            kind: "not_found" as const,
          };
        }

        // Only the campaign's organizer can add milestones.
        if (campaign.organizerId !== req.user!.id) {
          return {
            kind: "forbidden" as const,
          };
        }

        // Calculate the existing milestone allocation.
        const existingBudget = campaign.milestones.reduce(
          (total, milestone) =>
            total + milestone.budgetAmountCents,
          0
        );

        // Prevent the total allocation from exceeding the goal.
        if (
          existingBudget + input.budgetAmountCents >
          campaign.goalAmountCents
        ) {
          return {
            kind: "budget_exceeded" as const,
          };
        }

        // Create the milestone inside the same transaction.
        const milestone = await tx.milestone.create({
  data: {
    campaignId: campaign.id,
    title: input.title,
    budgetAmountCents: input.budgetAmountCents,
    dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
  },
});

        return {
          kind: "created" as const,
          milestone,
        };
      });

      if (result.kind === "not_found") {
        return res.status(404).json({
          error: "Campaign not found",
        });
      }

      if (result.kind === "forbidden") {
        return res.status(403).json({
          error: "You cannot modify this campaign",
        });
      }

      if (result.kind === "budget_exceeded") {
        return res.status(400).json({
          error: "Total milestone budget cannot exceed campaign goal",
        });
      }

      return res.status(201).json(result.milestone);
    } catch (error) {
      console.error("Create milestone error:", error);

      return res.status(500).json({
        error: "Failed to create milestone",
      });
    }
  }
);

// ==========================================
// GET /campaigns/:campaignId/impact-update
// Generate AI impact update for donors
// ==========================================

router.get("/:campaignId/impact-update", async (req, res) => {
  const campaignId = req.params.campaignId;

  if (typeof campaignId !== "string") {
    return res.status(400).json({
      error: "Invalid campaign ID",
    });
  }

  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        organization: true,
        donations: {
          where: { status: "completed" },
          select: {
            amountCents: true,
            donorId: true,
          },
        },
        milestones: {
          include: {
            payout: {
              select: { amountCents: true, status: true },
            },
          },
          orderBy: { dueDate: "asc" },
        },
      },
    });

    if (!campaign) {
      return res.status(404).json({
        error: "Campaign not found",
      });
    }

    const raisedCents = campaign.donations.reduce(
      (sum, d) => sum + d.amountCents,
      0
    );

    const donorCount = new Set(campaign.donations.map((d) => d.donorId)).size;

    const milestones = campaign.milestones.map((m) => {
      const paidCents = m.payout?.status === "paid" ? m.payout.amountCents : 0;
      return {
        title: m.title,
        status: m.status as "open" | "evidence_submitted" | "approved" | "rejected" | "paid",
        budgetCents: m.budgetAmountCents,
        paidCents,
      };
    });

    const latestLedger = await prisma.ledgerEvent.findFirst({
      orderBy: { createdAt: "desc" },
      select: { hash: true },
    });

    const facts = {
      campaignTitle: campaign.title,
      organizationName: campaign.organization.name,
      goalCents: campaign.goalAmountCents,
      raisedCents,
      donorCount,
      milestones,
      latestLedgerHash: latestLedger?.hash ?? null,
    };

    const result = await draftImpactUpdate(facts);

    if (!result.ok) {
      return res.status(500).json({
        error: "Failed to generate impact update",
        reason: result.reason,
      });
    }

    return res.status(200).json({
      facts,
      update: result.data,
    });
  } catch (error) {
    console.error("Impact update error:", error);

    return res.status(500).json({
      error: "Failed to generate impact update",
    });
  }
});

export default router;
