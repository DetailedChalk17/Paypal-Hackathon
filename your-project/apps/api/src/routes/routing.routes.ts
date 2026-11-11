import { Router } from "express";
import { RoutingSuggestionInputSchema } from "@your-project/shared";
import { prisma } from "../lib/prisma";

const router = Router();

router.post("/suggest", async (req, res) => {
  const parsed = RoutingSuggestionInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Enter a goal and a positive donation amount.",
      details: parsed.error.flatten(),
    });
  }

  try {
    const campaigns = await prisma.campaign.findMany({
      where: { status: "active", currency: "USD" },
      include: {
        organization: {
          select: { name: true, cause: true, trustScore: true },
        },
        donations: {
          where: { status: "completed" },
          select: { amountCents: true },
        },
      },
    });

    const goal = parsed.data.goal.toLowerCase();
    const ranked = campaigns
      .map((campaign) => {
        const raised = campaign.donations.reduce((total, donation) => total + donation.amountCents, 0);
        const gapAmountCents = Math.max(0, campaign.goalAmountCents - raised);
        const gapPercent = campaign.goalAmountCents > 0
          ? (gapAmountCents / campaign.goalAmountCents) * 100
          : 0;
        const matchesGoal = goal.includes(campaign.organization.cause.toLowerCase());
        const score =
          campaign.organization.trustScore * 0.6 +
          gapPercent * 0.25 +
          (matchesGoal ? 15 : 0);

        return {
          campaign,
          score,
          gapAmountCents,
          matchesGoal,
        };
      })
      .filter((item) => item.gapAmountCents > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (ranked.length === 0) {
      return res.status(200).json({ suggestions: [] });
    }

    const weights = ranked.map((item) => Math.max(item.score, 1));
    const totalWeight = weights.reduce((total, weight) => total + weight, 0);
    let allocated = 0;

    const suggestions = ranked.map((item, index) => {
      const amountCents =
        index === ranked.length - 1
          ? parsed.data.amountCents - allocated
          : Math.floor((parsed.data.amountCents * weights[index]) / totalWeight);
      allocated += amountCents;
      return {
        campaignId: item.campaign.id,
        title: item.campaign.title,
        organizationName: item.campaign.organization.name,
        cause: item.campaign.organization.cause,
        amountCents,
        trustScore: item.campaign.organization.trustScore,
        reason: `${item.campaign.organization.name} has a trust score of ${item.campaign.organization.trustScore}, a ${Math.round((item.gapAmountCents / item.campaign.goalAmountCents) * 100)}% funding gap${item.matchesGoal ? ", and matches your stated goal" : ""}.`,
      };
    });

    return res.status(200).json({ suggestions });
  } catch (error) {
    console.error("Routing suggestions failed:", error);
    return res.status(500).json({ error: "Unable to suggest a donation split." });
  }
});

export default router;
