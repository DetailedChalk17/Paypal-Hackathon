import { Router } from "express";
import { prisma } from "../lib/prisma";
import { getNetDonationAmountsCents } from "../services/refund.service";

const router = Router();

// ==========================================
// GET /dashboard/summary
// Dashboard summary for AG Studio widgets
// ==========================================

router.get("/summary", async (_req, res) => {
  try {
    const [
      donationRows,
      spendByCategory,
      fundingGapCampaigns,
      flags,
      trustScores,
    ] = await Promise.all([

      // 1. Fetch successful donations for net daily accounting.
      prisma.$queryRaw<
        Array<{
          date: string;
          donationId: string;
          amountCents: number;
          status: string;
          paypalCaptureId: string | null;
          currencyCode: string;
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
          c."currency" AS "currencyCode"
        FROM completed_events e
        JOIN "Donation" d ON d."id" = e."entityId"
        JOIN "Campaign" c ON c."id" = d."campaignId"
        WHERE d."status" = 'completed'
        ORDER BY DATE(e."createdAt"), d."id"
      `,

      // 2. Paid spending grouped by organization cause.
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

      // 3. Load active campaigns and their completed donations.
      // Net amounts are calculated after the batch queries below.
      prisma.campaign.findMany({
        where: {
          status: "active",
        },
        select: {
          id: true,
          title: true,
          goalAmountCents: true,
          currency: true,
          organization: {
            select: {
              name: true,
            },
          },
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
      }),

      // 4. Dashboard flags.
      prisma.$queryRaw<
        Array<{
          type: string;
          count: bigint;
        }>
      >`
        SELECT
          'pendingEvidence' AS "type",
          COUNT(*)::BIGINT AS "count"
        FROM "Evidence"
        WHERE "reviewerDecision" = 'pending'

        UNION ALL

        SELECT
          'rejectedEvidence' AS "type",
          COUNT(*)::BIGINT AS "count"
        FROM "Evidence"
        WHERE "reviewerDecision" = 'rejected'

        UNION ALL

        SELECT
          'overdueMilestones' AS "type",
          COUNT(*)::BIGINT AS "count"
        FROM "Milestone"
        WHERE
          "dueDate" < NOW()
          AND "status" IN ('open', 'rejected')

        UNION ALL

        SELECT
          'failedPayouts' AS "type",
          COUNT(*)::BIGINT AS "count"
        FROM "Payout"
        WHERE "status" = 'failed'
      `,

      // 5. Saved organization trust scores.
      prisma.organization.findMany({
        select: {
          id: true,
          name: true,
          trustScore: true,
          verified: true,
          trustScoreUpdatedAt: true,
        },
        orderBy: {
          trustScore: "desc",
        },
      }),
    ]);

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

    // Include daily donation rows.
    for (const row of donationRows) {
      netDonationInputs.set(row.donationId, {
        id: row.donationId,
        amountCents: row.amountCents,
        status: row.status,
        paypalCaptureId: row.paypalCaptureId,
        currencyCode: row.currencyCode,
      });
    }

    // Include completed donations belonging to active campaigns.
    for (const campaign of fundingGapCampaigns) {
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

    // Calculate net amounts once for both dashboard sections.
    const netAmounts = await getNetDonationAmountsCents(
      prisma,
      Array.from(netDonationInputs.values())
    );

    const dailyTotals = new Map<
      string,
      { donationCount: number; amountCents: number }
    >();

    for (const row of donationRows) {
      const current = dailyTotals.get(row.date) ?? {
        donationCount: 0,
        amountCents: 0,
      };

      current.donationCount += 1;
      current.amountCents += netAmounts.get(row.donationId) ?? 0;

      dailyTotals.set(row.date, current);
    }

    const donationsByDay = Array.from(
      dailyTotals,
      ([date, totals]) => ({
        date,
        donationCount: totals.donationCount,
        amountCents: totals.amountCents,
      })
    );

    const fundingGaps = fundingGapCampaigns
      .map((campaign) => {
        const raisedAmountCents = campaign.donations.reduce(
          (total, donation) =>
            total + (netAmounts.get(donation.id) ?? 0),
          0
        );

        return {
          campaignId: campaign.id,
          campaignTitle: campaign.title,
          organizationName: campaign.organization.name,
          goalAmountCents: campaign.goalAmountCents,
          raisedAmountCents,
          fundingGapCents: Math.max(
            campaign.goalAmountCents - raisedAmountCents,
            0
          ),
        };
      })
      .filter((campaign) => campaign.fundingGapCents > 0)
      .sort(
        (a, b) => b.fundingGapCents - a.fundingGapCents
      );

    return res.status(200).json({
      generatedAt: new Date().toISOString(),

      donationsByDay: donationsByDay.map((item) => ({
        date: item.date,
        donationCount: Number(item.donationCount),
        amountCents: Number(item.amountCents),
      })),

      spendByCategory: spendByCategory.map((item) => ({
        category: item.category,
        payoutCount: Number(item.payoutCount),
        amountCents: Number(item.amountCents),
      })),

      fundingGaps: fundingGaps.map((item) => ({
        campaignId: item.campaignId,
        campaignTitle: item.campaignTitle,
        organizationName: item.organizationName,
        goalAmountCents: Number(item.goalAmountCents),
        raisedAmountCents: Number(item.raisedAmountCents),
        fundingGapCents: Number(item.fundingGapCents),
      })),

      flags: flags.map((item) => ({
        type: item.type,
        count: Number(item.count),
      })),

      trustScores: trustScores.map((item) => ({
        organizationId: item.id,
        organizationName: item.name,
        trustScore: item.trustScore,
        verified: item.verified,
        updatedAt: item.trustScoreUpdatedAt,
      })),
    });
  } catch (error) {
    console.error("Dashboard summary error:", error);

    return res.status(500).json({
      error: "Failed to fetch dashboard summary",
    });
  }
});

export default router;
