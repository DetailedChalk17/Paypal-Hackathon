import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();

router.get("/summary", requireAuth, async (req, res) => {
  try {
    const requestedRange = typeof req.query.range === "string" ? req.query.range : "half";
    const monthsToInclude = requestedRange === "month" ? 1 : requestedRange === "quarter" ? 3 : requestedRange === "half" ? 6 : null;
    if (monthsToInclude === null) {
      return res.status(400).json({ error: "Range must be month, quarter, or half." });
    }
    const cause = typeof req.query.cause === "string" ? req.query.cause : undefined;
    const now = new Date();
    const monthKeys = Array.from({ length: monthsToInclude }, (_value, index) => {
      const date = new Date(now.getFullYear(), now.getMonth() - (monthsToInclude - 1 - index), 1);
      return date.toISOString().slice(0, 7);
    });
    const [allCampaigns, ledgerEvents, allOrganizations, allPendingEvidence, paidPayouts] =
      await Promise.all([
        prisma.campaign.findMany({
          include: {
            organization: { select: { name: true, cause: true } },
            donations: {
              where: { status: "completed" },
              select: { id: true, amountCents: true },
            },
          },
        }),
        prisma.ledgerEvent.findMany({
          where: {
            type: "DONATION_COMPLETED",
            createdAt: { gte: new Date(now.getFullYear(), now.getMonth() - (monthsToInclude - 1), 1) },
          },
          orderBy: { createdAt: "asc" },
          select: { entityId: true, createdAt: true, payload: true },
        }),
        prisma.organization.findMany({
          select: { name: true, trustScore: true, cause: true },
          orderBy: { trustScore: "desc" },
        }),
        prisma.evidence.findMany({
          where: { reviewerDecision: "pending" },
          include: {
            milestone: {
              include: {
                campaign: {
                  include: { organization: { select: { name: true, cause: true } } },
                },
              },
            },
          },
        }),
        prisma.payout.aggregate({
          where: {
            status: "paid",
            ...(cause ? { milestone: { campaign: { organization: { cause } } } } : {}),
          },
          _sum: { amountCents: true },
        }),
      ]);

    const campaigns = cause
      ? allCampaigns.filter((campaign) => campaign.organization.cause === cause)
      : allCampaigns;
    const organizations = cause
      ? allOrganizations.filter((organization) => organization.cause === cause)
      : allOrganizations;
    const pendingEvidence = cause
      ? allPendingEvidence.filter((evidence) => evidence.milestone.campaign.organization.cause === cause)
      : allPendingEvidence;
    const donationCauses = new Map(
      allCampaigns.flatMap((campaign) =>
        campaign.donations.map((donation) => [donation.id, campaign.organization.cause] as const),
      ),
    );
    const donationsByMonth = new Map(monthKeys.map((key) => [key, 0]));
    for (const event of ledgerEvents) {
      const payload = event.payload;
      if (
        (!cause || donationCauses.get(event.entityId) === cause) &&
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        typeof payload.amountCents === "number"
      ) {
        const key = event.createdAt.toISOString().slice(0, 7);
        donationsByMonth.set(key, (donationsByMonth.get(key) ?? 0) + payload.amountCents);
      }
    }

    const donationsOverTime = monthKeys.map((key) => ({
      label: new Intl.DateTimeFormat("en-US", { month: "short" }).format(new Date(`${key}-01T00:00:00.000Z`)),
      amountCents: donationsByMonth.get(key) ?? 0,
    }));

    const causeTotals = new Map<string, number>();
    for (const campaign of campaigns) {
      const amount = campaign.donations.reduce((total, donation) => total + donation.amountCents, 0);
      const cause = campaign.organization.cause;
      causeTotals.set(cause, (causeTotals.get(cause) ?? 0) + amount);
    }

    const fundingGaps = campaigns
      .map((campaign) => {
        const raised = campaign.donations.reduce((total, donation) => total + donation.amountCents, 0);
        return {
          campaignId: campaign.id,
          title: campaign.title,
          gapAmountCents: Math.max(0, campaign.goalAmountCents - raised),
          cause: campaign.organization.cause,
        };
      })
      .sort((a, b) => b.gapAmountCents - a.gapAmountCents)
      .slice(0, 8);

    const flags = pendingEvidence.map((evidence) => {
      const findings = evidence.aiFindings;
      const detail =
        typeof findings === "object" &&
        findings !== null &&
        !Array.isArray(findings) &&
        typeof findings.summary === "string"
          ? findings.summary
          : `${evidence.milestone.campaign.title} · ${evidence.milestone.title}`;
      return {
        id: evidence.id,
        title: "Evidence needs review",
        detail,
        severity: "medium",
        cause: evidence.milestone.campaign.organization.cause,
      };
    });

    return res.status(200).json({
      donationsOverTime,
      spendByCause: Array.from(causeTotals, ([cause, amountCents]) => ({ cause, amountCents })),
      fundingGaps,
      trustScores: organizations.map((organization) => ({
        organization: organization.name,
        score: organization.trustScore,
        cause: organization.cause,
      })),
      flags,
      totals: {
        campaignCount: campaigns.length,
        completedDonationCents: campaigns.reduce(
          (total, campaign) => total + campaign.donations.reduce((sum, donation) => sum + donation.amountCents, 0),
          0,
        ),
        pendingEvidenceCount: pendingEvidence.length,
        paidPayoutCents: paidPayouts._sum.amountCents ?? 0,
      },
    });
  } catch (error) {
    console.error("Dashboard summary failed:", error);
    return res.status(500).json({ error: "Unable to load dashboard summary." });
  }
});

export default router;
