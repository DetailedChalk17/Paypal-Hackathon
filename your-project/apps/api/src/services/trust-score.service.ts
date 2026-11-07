
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

type ScoreEvidence = {
  id: string;
  reviewerDecision: string;
  submittedAt: Date;
  ledgerApproved: boolean;
};

type ScorePayout = {
  id: string;
  ledgerSucceeded: boolean;
};

type ScoreMilestone = {
  status: string;
  dueDate: Date | null;
  budgetAmountCents: number;
  evidence: ScoreEvidence[];
  payouts: ScorePayout[];
};

type ScoreCampaign = {
  goalAmountCents: number;
  milestones: ScoreMilestone[];
};

type ScoreComponent = {
  weight: number;
  earnedPoints: number;
  numerator: number;
  denominator: number;
  applicable: boolean;
};

export type TrustScoreBreakdown = {
  version: 1;
  calculatedAt: string;
  score: number;
  coveragePercent: number;
  earnedPoints: number;
  availablePoints: number;
  components: {
    approvedWithEvidence: ScoreComponent;
    onTimeUpdates: ScoreComponent;
    budgetCompliance: ScoreComponent;
    completedMilestones: ScoreComponent;
  };
};

function calculateComponent(
  weight: number,
  numerator: number,
  denominator: number
): ScoreComponent {
  const applicable = denominator > 0;

  const earnedPoints = applicable
    ? Math.round((numerator / denominator) * weight * 100) / 100
    : 0;

  return { weight, earnedPoints, numerator, denominator, applicable };
}

export function calculateTrustScore(
  campaigns: ScoreCampaign[],
  now: Date = new Date()
): TrustScoreBreakdown {
  const milestones = campaigns.flatMap((campaign) => campaign.milestones);

  // 1. Approved milestones with evidence: 40 points.
  // Approval must be supported by an evidence_approved ledger event.
  const approvedMilestones = milestones.filter((milestone) =>
    milestone.evidence.some(
      (evidence) =>
        evidence.reviewerDecision === "approved" &&
        evidence.ledgerApproved
    )
  );

  const approvedWithEvidence = calculateComponent(
    40,
    approvedMilestones.length,
    milestones.length
  );

  // 2. On-time evidence updates: 20 points.
  const eligibleUpdates = milestones.filter(
    (milestone) =>
      milestone.dueDate !== null &&
      (milestone.dueDate.getTime() <= now.getTime() ||
        milestone.evidence.length > 0)
  );

  const onTimeUpdatesCount = eligibleUpdates.filter((milestone) =>
    milestone.evidence.some(
      (evidence) =>
        evidence.submittedAt.getTime() <= milestone.dueDate!.getTime()
    )
  ).length;

  const onTimeUpdates = calculateComponent(
    20,
    onTimeUpdatesCount,
    eligibleUpdates.length
  );

  // 3. Budget compliance: 20 points.
  // Compare total milestone allocations with the campaign goal.
  const campaignsWithMilestones = campaigns.filter(
    (campaign) => campaign.milestones.length > 0
  );

  const budgetCompliantCampaigns = campaignsWithMilestones.filter(
    (campaign) => {
      const allocatedBudget = campaign.milestones.reduce(
        (total, milestone) => total + milestone.budgetAmountCents,
        0
      );

      return allocatedBudget <= campaign.goalAmountCents;
    }
  );

  const budgetCompliance = calculateComponent(
    20,
    budgetCompliantCampaigns.length,
    campaignsWithMilestones.length
  );

  // 4. Completed milestones: 20 points.
  // Completion requires a successful payout ledger event.
  const completedMilestonesCount = milestones.filter((milestone) =>
    milestone.payouts.some((payout) => payout.ledgerSucceeded)
  ).length;

  const completedMilestones = calculateComponent(
    20,
    completedMilestonesCount,
    milestones.length
  );

  const components = {
    approvedWithEvidence,
    onTimeUpdates,
    budgetCompliance,
    completedMilestones,
  };

  const componentList = Object.values(components);

  const availablePoints = componentList
    .filter((component) => component.applicable)
    .reduce((total, component) => total + component.weight, 0);

  const earnedPoints = componentList.reduce(
    (total, component) => total + component.earnedPoints,
    0
  );

  const score =
    availablePoints > 0
      ? Math.round((earnedPoints / availablePoints) * 100)
      : 0;

  return {
    version: 1,
    calculatedAt: now.toISOString(),
    score,
    coveragePercent: availablePoints,
    earnedPoints: Math.round(earnedPoints * 100) / 100,
    availablePoints,
    components,
  };
}

export async function recalculateOrganizationTrustScore(
  organizationId: string
) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      campaigns: {
        include: {
          milestones: {
            include: {
              evidence: {
                select: {
                  id: true,
                  reviewerDecision: true,
                  submittedAt: true,
                },
              },
              payouts: {
                select: {
                  id: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!organization) {
    throw new Error("Organization not found");
  }

  const evidenceIds = organization.campaigns.flatMap((campaign) =>
    campaign.milestones.flatMap((milestone) =>
      milestone.evidence.map((evidence) => evidence.id)
    )
  );

  const payoutIds = organization.campaigns.flatMap((campaign) =>
    campaign.milestones.flatMap((milestone) =>
      milestone.payouts.map((payout) => payout.id)
    )
  );

  // Read the actual approval and payout-success facts from the ledger.
  const [approvalEvents, payoutEvents] = await Promise.all([
    evidenceIds.length
      ? prisma.ledgerEvent.findMany({
          where: {
            type: "evidence_approved",
            entityId: { in: evidenceIds },
          },
          select: { entityId: true },
        })
      : Promise.resolve([]),

    payoutIds.length
      ? prisma.ledgerEvent.findMany({
          where: {
            type: "PAYOUT_ITEM_SUCCEEDED",
            entityId: { in: payoutIds },
          },
          select: { entityId: true },
        })
      : Promise.resolve([]),
  ]);

  const approvedEvidenceIds = new Set(
    approvalEvents.map((event) => event.entityId)
  );

  const successfulPayoutIds = new Set(
    payoutEvents.map((event) => event.entityId)
  );

  const scoreCampaigns: ScoreCampaign[] = organization.campaigns.map(
    (campaign) => ({
      goalAmountCents: campaign.goalAmountCents,
      milestones: campaign.milestones.map((milestone) => ({
        status: milestone.status,
        dueDate: milestone.dueDate,
        budgetAmountCents: milestone.budgetAmountCents,
        evidence: milestone.evidence.map((evidence) => ({
          ...evidence,
          ledgerApproved: approvedEvidenceIds.has(evidence.id),
        })),
        payouts: milestone.payouts.map((payout) => ({
          id: payout.id,
          ledgerSucceeded: successfulPayoutIds.has(payout.id),
        })),
      })),
    })
  );

  const breakdown = calculateTrustScore(scoreCampaigns);

  await prisma.organization.update({
    where: { id: organizationId },
    data: {
      trustScore: breakdown.score,
      trustScoreBreakdown:
        breakdown as unknown as Prisma.InputJsonObject,
      trustScoreUpdatedAt: new Date(breakdown.calculatedAt),
    },
  });

  return {
    organizationId,
    ...breakdown,
  };
}
