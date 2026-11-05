import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

// ==========================================
// GET /dashboard/summary
// Dashboard summary for AG Studio widgets
// ==========================================

router.get("/summary", async (_req, res) => {
  try {
    const [
      donationsByDay,
      spendByCategory,
      fundingGaps,
      flags,
      trustScores,
    ] = await Promise.all([

      // 1. Successful donations grouped by day.
      prisma.$queryRaw<
        Array<{
          date: string;
          donationCount: bigint;
          amountCents: bigint;
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
          COUNT(*)::BIGINT AS "donationCount",
          COALESCE(SUM(d."amountCents"), 0)::BIGINT AS "amountCents"
        FROM completed_events e
        JOIN "Donation" d ON d."id" = e."entityId"
        WHERE d."status" = 'completed'
        GROUP BY DATE(e."createdAt")
        ORDER BY DATE(e."createdAt") ASC
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

      // 3. Remaining funding gaps for active campaigns.
      prisma.$queryRaw<
        Array<{
          campaignId: string;
          campaignTitle: string;
          organizationName: string;
          goalAmountCents: bigint;
          raisedAmountCents: bigint;
          fundingGapCents: bigint;
        }>
      >`
        SELECT
          c."id" AS "campaignId",
          c."title" AS "campaignTitle",
          o."name" AS "organizationName",
          c."goalAmountCents"::BIGINT AS "goalAmountCents",
          COALESCE(
            SUM(d."amountCents")
            FILTER (WHERE d."status" = 'completed'),
            0
          )::BIGINT AS "raisedAmountCents",
          GREATEST(
            c."goalAmountCents"::BIGINT -
            COALESCE(
              SUM(d."amountCents")
              FILTER (WHERE d."status" = 'completed'),
              0
            ),
            0
          )::BIGINT AS "fundingGapCents"
        FROM "Campaign" c
        JOIN "Organization" o ON o."id" = c."organizationId"
        LEFT JOIN "Donation" d ON d."campaignId" = c."id"
        WHERE c."status" = 'active'
        GROUP BY
          c."id",
          c."title",
          c."goalAmountCents",
          o."name"
        HAVING
          c."goalAmountCents"::BIGINT -
          COALESCE(
            SUM(d."amountCents")
            FILTER (WHERE d."status" = 'completed'),
            0
          ) > 0
        ORDER BY "fundingGapCents" DESC
      `,

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
