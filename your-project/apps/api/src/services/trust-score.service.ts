
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

// ==========================================
// TRUST SCORE INPUT TYPES
// ==========================================

type ScoreEvidence = {
  reviewerDecision: string;
  submittedAt: Date;
};

type ScoreMilestone = {
  status: string;
  dueDate: Date | null;
  budgetAmountCents: number;
  evidence: ScoreEvidence[];
};

type ScoreCampaign = {
  goalAmountCents: number;
  milestones: ScoreMilestone[];
};

// ==========================================
// TRUST SCORE BREAKDOWN
// ==========================================

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

// ==========================================
// HELPERS
// ==========================================

function calculateComponent(
  weight: number,
  numerator: number,
  denominator: number
): ScoreComponent {
  const applicable = denominator > 0;

  const earnedPoints = applicable
    ? Math.round((numerator / denominator) * weight * 100) / 100
    : 0;

  return {
    weight,
    earnedPoints,
    numerator,
    denominator,
    applicable,
  };
}

// ==========================================
// PURE TRUST SCORE CALCULATION
// No database calls and no AI.
// ==========================================

export function calculateTrustScore(
  campaigns: ScoreCampaign[],
  now: Date = new Date()
): TrustScoreBreakdown {
  const milestones = campaigns.flatMap(
    (campaign) => campaign.milestones
  );

  // 1. Milestones approved with evidence (40 points).

  const approvedMilestones = milestones.filter(
    (milestone) =>
      milestone.evidence.some(
        (evidence) =>
          evidence.reviewerDecision === "approved"
      )
  );

  const approvedWithEvidence = calculateComponent(
    40,
    approvedMilestones.length,
    milestones.length
  );

  // 2. On-time evidence updates (20 points).
  // Future milestones without submitted evidence are not
  // considered overdue or evaluated yet.

  const eligibleUpdates = milestones.filter(
    (milestone) =>
      milestone.dueDate !== null &&
      (
        milestone.dueDate.getTime() <= now.getTime() ||
        milestone.evidence.length > 0
      )
  );

  const onTimeUpdatesCount = eligibleUpdates.filter(
    (milestone) =>
      milestone.evidence.some(
        (evidence) =>
          evidence.submittedAt.getTime() <=
          milestone.dueDate!.getTime()
      )
  ).length;

  const onTimeUpdates = calculateComponent(
    20,
    onTimeUpdatesCount,
    eligibleUpdates.length
  );

  // 3. Staying within campaign budgets (20 points).
  // Only campaigns with at least one milestone are evaluated.

  const campaignsWithMilestones = campaigns.filter(
    (campaign) => campaign.milestones.length > 0
  );

  const budgetCompliantCampaigns =
    campaignsWithMilestones.filter((campaign) => {
      const allocatedBudget = campaign.milestones.reduce(
        (total, milestone) =>
          total + milestone.budgetAmountCents,
        0
      );

      return (
        allocatedBudget <= campaign.goalAmountCents
      );
    });

  const budgetCompliance = calculateComponent(
    20,
    budgetCompliantCampaigns.length,
    campaignsWithMilestones.length
  );

  // 4. Completed milestones (20 points).
  // A paid milestone is considered completed.

  const completedMilestonesCount = milestones.filter(
    (milestone) => milestone.status === "paid"
  ).length;

  const completedMilestones = calculateComponent(
    20,
    completedMilestonesCount,
    milestones.length
  );

  // ==========================================
  // FINAL SCORE
  // Normalize over applicable components only.
  // This avoids penalizing organizations for missing
  // historical deadline data.
  // ==========================================

  const components = {
    approvedWithEvidence,
    onTimeUpdates,
    budgetCompliance,
    completedMilestones,
  };

  const componentList = Object.values(components);

  const availablePoints = componentList
    .filter((component) => component.applicable)
    .reduce(
      (total, component) => total + component.weight,
      0
    );

  const earnedPoints = componentList.reduce(
    (total, component) =>
      total + component.earnedPoints,
    0
  );

  const score =
    availablePoints > 0
      ? Math.round(
          (earnedPoints / availablePoints) * 100
        )
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

// ==========================================
// CALCULATE AND SAVE ORGANIZATION TRUST SCORE
// ==========================================

export async function recalculateOrganizationTrustScore(
  organizationId: string
) {
  const organization = await prisma.organization.findUnique({
    where: {
      id: organizationId,
    },
    include: {
      campaigns: {
        include: {
          milestones: {
            include: {
              evidence: {
                select: {
                  reviewerDecision: true,
                  submittedAt: true,
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

  const breakdown = calculateTrustScore(
    organization.campaigns
  );

  await prisma.organization.update({
    where: {
      id: organizationId,
    },
    data: {
      trustScore: breakdown.score,
      trustScoreBreakdown:
        breakdown as unknown as Prisma.InputJsonObject,
      trustScoreUpdatedAt: new Date(
        breakdown.calculatedAt
      ),
    },
  });

  return {
    organizationId,
    ...breakdown,
  };
}
