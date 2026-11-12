import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";
import { getNetDonationAmountsCents } from "../services/refund.service";

const router = Router();

router.get("/summary", requireAuth, async (req, res) => {
  const requestedRange =
    typeof req.query.range === "string" ? req.query.range : "half";
  const monthsToInclude =
    requestedRange === "month"
      ? 1
      : requestedRange === "quarter"
        ? 3
        : requestedRange === "half"
          ? 6
          : null;

  if (monthsToInclude === null) {
    return res.status(400).json({
      error: "Range must be month, quarter, or half.",
    });
  }

  if (req.query.cause !== undefined && typeof req.query.cause !== "string") {
    return res.status(400).json({ error: "Cause must be a string." });
  }

  const cause = typeof req.query.cause === "string" ? req.query.cause : undefined;
  const now = new Date();
  const startDate = new Date(
    now.getFullYear(),
    now.getMonth() - (monthsToInclude - 1),
    1,
  );
  const monthKeys = Array.from({ length: monthsToInclude }, (_value, index) => {
    const date = new Date(
      now.getFullYear(),
      now.getMonth() - (monthsToInclude - 1 - index),
      1,
    );
    return date.toISOString().slice(0, 7);
  });

  try {
    const [
      donationRows,
      spendByCategory,
      campaigns,
      flagCounts,
      trustScores,
      pendingEvidence,
      paidPayouts,
    ] = await Promise.all([
      prisma.$queryRaw<
        Array<{
          date: string;
          donationId: string;
          amountCents: number;
          status: string;
          paypalCaptureId: string | null;
          currencyCode: string;
          cause: string;
        }>
      >`
        WITH completed_events AS (
          SELECT DISTINCT ON ("entityId")
            "entityId", "createdAt"
          FROM "LedgerEvent"
          WHERE "type" = 'DONATION_COMPLETED'
          ORDER BY "entityId", "createdAt" ASC
        )
        SELECT
          TO_CHAR(DATE(e."createdAt"), 'YYYY-MM-DD') AS "date",
          d."id" AS "donationId",
          d."amountCents" AS "amountCents",
          d."status" AS "status",
          d."paypalCaptureId" AS "paypalCaptureId",
          c."currency" AS "currencyCode",
          o."cause" AS "cause"
        FROM completed_events e
        JOIN "Donation" d ON d."id" = e."entityId"
        JOIN "Campaign" c ON c."id" = d."campaignId"
        JOIN "Organization" o ON o."id" = c."organizationId"
        WHERE d."status" = 'completed' AND e."createdAt" >= ${startDate}
        ORDER BY DATE(e."createdAt"), d."id"
      `,
      prisma.$queryRaw<
        Array<{
          category: string;
          payoutCount: bigint;
          amountCents: bigint;
        }>
      >`
        SELECT
          o."cause" AS "category",
          COUNT(*)::BIGINT AS "payoutCount",
          SUM(p."amountCents")::BIGINT AS "amountCents"
        FROM "Payout" p
        JOIN "Milestone" m ON m."id" = p."milestoneId"
        JOIN "Campaign" c ON c."id" = m."campaignId"
        JOIN "Organization" o ON o."id" = c."organizationId"
        WHERE p."status" = 'paid'
        GROUP BY o."cause"
        ORDER BY SUM(p."amountCents") DESC
      `,
      prisma.campaign.findMany({
        where: {
          status: "active",
          ...(cause ? { organization: { cause } } : {}),
        },
        select: {
          id: true,
          title: true,
          goalAmountCents: true,
          currency: true,
          organization: { select: { name: true, cause: true } },
          donations: {
            where: { status: "completed" },
            select: {
              id: true,
              amountCents: true,
              status: true,
              paypalCaptureId: true,
            },
          },
        },
      }),
      prisma.$queryRaw<Array<{ type: string; count: bigint }>>`
        SELECT 'pendingEvidence' AS "type", COUNT(*)::BIGINT AS "count"
        FROM "Evidence"
        WHERE "reviewerDecision" = 'pending'
        UNION ALL
        SELECT 'rejectedEvidence' AS "type", COUNT(*)::BIGINT AS "count"
        FROM "Evidence"
        WHERE "reviewerDecision" = 'rejected'
        UNION ALL
        SELECT 'overdueMilestones' AS "type", COUNT(*)::BIGINT AS "count"
        FROM "Milestone"
        WHERE "dueDate" < NOW() AND "status" IN ('open', 'rejected')
        UNION ALL
        SELECT 'failedPayouts' AS "type", COUNT(*)::BIGINT AS "count"
        FROM "Payout"
        WHERE "status" = 'failed'
      `,
      prisma.organization.findMany({
        where: cause ? { cause } : undefined,
        select: {
          id: true,
          name: true,
          cause: true,
          trustScore: true,
          verified: true,
          trustScoreUpdatedAt: true,
        },
        orderBy: { trustScore: "desc" },
      }),
      prisma.evidence.findMany({
        where: {
          reviewerDecision: "pending",
          ...(cause
            ? { milestone: { campaign: { organization: { cause } } } }
            : {}),
        },
        include: {
          milestone: {
            include: {
              campaign: {
                include: { organization: { select: { cause: true } } },
              },
            },
          },
        },
      }),
      prisma.payout.aggregate({
        where: {
          status: "paid",
          ...(cause
            ? { milestone: { campaign: { organization: { cause } } } }
            : {}),
        },
        _sum: { amountCents: true },
      }),
    ]);

    const filteredDonationRows = donationRows.filter(
      (row) => !cause || row.cause === cause,
    );
    const netDonationInputs = new Map<
      string,
      {
        id: string;
        amountCents: number;
        status: string;
        paypalCaptureId: string | null;
        currencyCode: string;
      }
    >();

    for (const row of filteredDonationRows) {
      netDonationInputs.set(row.donationId, {
        id: row.donationId,
        amountCents: row.amountCents,
        status: row.status,
        paypalCaptureId: row.paypalCaptureId,
        currencyCode: row.currencyCode,
      });
    }

    for (const campaign of campaigns) {
      for (const donation of campaign.donations) {
        netDonationInputs.set(donation.id, {
          id: donation.id,
          amountCents: donation.amountCents,
          status: donation.status,
          paypalCaptureId: donation.paypalCaptureId,
          currencyCode: campaign.currency,
        });
      }
    }

    const netAmounts = await getNetDonationAmountsCents(
      prisma,
      Array.from(netDonationInputs.values()),
    );
    const dailyTotals = new Map<
      string,
      { donationCount: number; amountCents: number }
    >();
    const monthlyTotals = new Map(monthKeys.map((key) => [key, 0]));

    for (const row of filteredDonationRows) {
      const netAmount = netAmounts.get(row.donationId) ?? 0;
      const dailyTotal = dailyTotals.get(row.date) ?? {
        donationCount: 0,
        amountCents: 0,
      };
      dailyTotal.donationCount += 1;
      dailyTotal.amountCents += netAmount;
      dailyTotals.set(row.date, dailyTotal);

      const month = row.date.slice(0, 7);
      monthlyTotals.set(month, (monthlyTotals.get(month) ?? 0) + netAmount);
    }

    const fundingGaps = campaigns
      .map((campaign) => {
        const raisedAmountCents = campaign.donations.reduce(
          (total, donation) => total + (netAmounts.get(donation.id) ?? 0),
          0,
        );
        return {
          campaignId: campaign.id,
          campaignTitle: campaign.title,
          organizationName: campaign.organization.name,
          goalAmountCents: campaign.goalAmountCents,
          raisedAmountCents,
          fundingGapCents: Math.max(
            campaign.goalAmountCents - raisedAmountCents,
            0,
          ),
          cause: campaign.organization.cause,
        };
      })
      .filter((campaign) => campaign.fundingGapCents > 0)
      .sort((a, b) => b.fundingGapCents - a.fundingGapCents);

    const evidenceFlags = pendingEvidence.map((evidence) => {
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

    const visibleSpend = spendByCategory.filter(
      (item) => !cause || item.category === cause,
    );
    const donationsByDay = Array.from(dailyTotals, ([date, totals]) => ({
      date,
      donationCount: totals.donationCount,
      amountCents: totals.amountCents,
    }));

    return res.status(200).json({
      generatedAt: now.toISOString(),
      donationsByDay,
      spendByCategory: visibleSpend.map((item) => ({
        category: item.category,
        payoutCount: Number(item.payoutCount),
        amountCents: Number(item.amountCents),
      })),
      fundingGaps: fundingGaps.map((item) => ({
        campaignId: item.campaignId,
        campaignTitle: item.campaignTitle,
        title: item.campaignTitle,
        organizationName: item.organizationName,
        goalAmountCents: item.goalAmountCents,
        raisedAmountCents: item.raisedAmountCents,
        fundingGapCents: item.fundingGapCents,
        gapAmountCents: item.fundingGapCents,
      })),
      flagCounts: flagCounts.map((item) => ({
        type: item.type,
        count: Number(item.count),
      })),
      donationsOverTime: monthKeys.map((key) => ({
        label: new Intl.DateTimeFormat("en-US", { month: "short" }).format(
          new Date(`${key}-01T00:00:00.000Z`),
        ),
        amountCents: monthlyTotals.get(key) ?? 0,
      })),
      spendByCause: visibleSpend.map((item) => ({
        cause: item.category,
        amountCents: Number(item.amountCents),
      })),
      trustScores: trustScores.map((item) => ({
        organizationId: item.id,
        organization: item.name,
        organizationName: item.name,
        score: item.trustScore,
        trustScore: item.trustScore,
        verified: item.verified,
        updatedAt: item.trustScoreUpdatedAt,
        cause: item.cause,
      })),
      flags: evidenceFlags,
      totals: {
        campaignCount: campaigns.length,
        completedDonationCents: filteredDonationRows.reduce(
          (total, row) => total + (netAmounts.get(row.donationId) ?? 0),
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