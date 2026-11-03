import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.middleware";
import { prisma } from "../lib/prisma";
import { CreateCampaignInputSchema } from "@your-project/shared";

const router = Router();

router.post(
  "/",
  requireAuth,
  requireRole("organizer"),
  async (req, res) => {
    try {
      const input = CreateCampaignInputSchema.parse(req.body);

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
      if (error instanceof Error && error.name === "ZodError") {
        return res.status(400).json({
          error: "Invalid campaign data",
          details: error.message,
        });
      }

      console.error(error);
      return res.status(500).json({
        error: "Failed to create campaign",
      });
    }
  }
);
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
        createdAt: "desc",
      },
    });

    return res.status(200).json(campaigns);
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Failed to fetch campaigns",
    });
  }
});
router.get("/:id", async (req, res) => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      include: {
        organization: true,
        milestones: true,
        donations: {
          where: { status: "completed" },
          select: { amountCents: true },
        },
      },
    });

    if (!campaign) {
      return res.status(404).json({
        error: "Campaign not found",
      });
    }

    const raisedAmountCents = campaign.donations.reduce(
      (total, donation) => total + donation.amountCents,
      0
    );

    return res.status(200).json({
      ...campaign,
      raisedAmountCents,
      donations: undefined,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: "Failed to fetch campaign",
    });
  }
});
router.post(
  "/:id/milestones",
  requireAuth,
  requireRole("organizer"),
  async (req, res) => {
    try {
      const input = CreateMilestoneInputSchema.parse(req.body);

      const campaign = await prisma.campaign.findUnique({
        where: { id: req.params.id },
        include: {
          milestones: true,
        },
      });

      if (!campaign) {
        return res.status(404).json({
          error: "Campaign not found",
        });
      }

      if (campaign.organizerId !== req.user!.id) {
        return res.status(403).json({
          error: "You cannot modify this campaign",
        });
      }

      const existingBudget = campaign.milestones.reduce(
        (total, milestone) => total + milestone.budgetAmountCents,
        0
      );

      if (existingBudget + input.budgetAmountCents > campaign.goalAmountCents) {
        return res.status(400).json({
          error: "Total milestone budget cannot exceed campaign goal",
        });
      }

      const milestone = await prisma.milestone.create({
        data: {
          campaignId: campaign.id,
          title: input.title,
          budgetAmountCents: input.budgetAmountCents,
        },
      });

      return res.status(201).json(milestone);
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        return res.status(400).json({
          error: "Invalid milestone data",
          details: error.message,
        });
      }

      console.error(error);
      return res.status(500).json({
        error: "Failed to create milestone",
      });
    }
  }
);
export default router;