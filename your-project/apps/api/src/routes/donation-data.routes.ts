
import { Router } from "express";

import { requireAuth } from "../middleware/auth.middleware";
import { prisma } from "../lib/prisma";
import { getNetDonationAmountsCents } from "../services/refund.service";

const router = Router();

// ==========================================
// TYPES
// ==========================================

type MilestoneForAllocation = {
  id: string;
  title: string;
  status: string;
  budgetAmountCents: number;
  evidence: {
    id: string;
    reviewerDecision: string;
    submittedAt: Date;
  }[];
  payout: {
    id: string;
    amountCents: number;
    status: string;
  } | null;
};

// ==========================================
// CALCULATE ESTIMATED MILESTONE ALLOCATIONS
// ==========================================

function getMilestoneAllocations(
  amountCents: number,
  goalAmountCents: number,
  milestones: MilestoneForAllocation[],
  donationStatus: string,
  netAmountCents = amountCents
) {
  const funded = donationStatus === "completed";
  const refunded = donationStatus === "refunded";

  const totalMilestoneBudget = milestones.reduce(
    (total, milestone) =>
      total + milestone.budgetAmountCents,
    0
  );

  // Never allocate more than the donation amount.
  const denominator = Math.max(
    goalAmountCents,
    totalMilestoneBudget
  );

  // Only completed donations are allocated.
  const eligibleAmount = funded ? netAmountCents : 0;

  const allocations = milestones.map((milestone) => {
    const hasApprovedEvidence = milestone.evidence.some(
      (evidence) =>
        evidence.reviewerDecision === "approved"
    );

    const hasRejectedEvidence = milestone.evidence.some(
      (evidence) =>
        evidence.reviewerDecision === "rejected"
    );

    let verificationStatus: string;

    if (hasApprovedEvidence) {
      verificationStatus = "verified";
    } else if (hasRejectedEvidence) {
      verificationStatus = "rejected";
    } else {
      verificationStatus = "pending";
    }

    const allocationAmountCents =
      eligibleAmount > 0 && denominator > 0
        ? Math.floor(
            (eligibleAmount *
              milestone.budgetAmountCents) /
              denominator
          )
        : 0;

    return {
      milestoneId: milestone.id,
      title: milestone.title,
      status: milestone.status,
      budgetAmountCents:
        milestone.budgetAmountCents,
      allocatedAmountCents:
        allocationAmountCents,
      verificationStatus,

      evidence: milestone.evidence.map((evidence) => ({
        id: evidence.id,
        reviewerDecision: evidence.reviewerDecision,
        submittedAt: evidence.submittedAt,
      })),

      // Preserve the existing API response as an array.
      payouts: milestone.payout
        ? [
            {
              id: milestone.payout.id,
              amountCents: milestone.payout.amountCents,
              status: milestone.payout.status,
            },
          ]
        : [],
    };
  });

  const allocatedAmountCents = allocations.reduce(
    (total, allocation) =>
      total + allocation.allocatedAmountCents,
    0
  );

  const sumByStatus = (status: string) =>
    allocations
      .filter(
        (allocation) =>
          allocation.verificationStatus === status
      )
      .reduce(
        (total, allocation) =>
          total + allocation.allocatedAmountCents,
        0
      );

  return {
    allocationMethod:
      "proportional_to_milestone_budgets",

    allocations,

    allocatedAmountCents,

    unallocatedAmountCents: Math.max(
      0,
      eligibleAmount - allocatedAmountCents
    ),

    verifiedAmountCents: sumByStatus("verified"),

    pendingAmountCents: sumByStatus("pending"),

    rejectedAmountCents: sumByStatus("rejected"),

    // Donations not yet successfully captured.
    notFundedAmountCents:
      donationStatus === "pending" ||
      donationStatus === "failed"
        ? amountCents
        : 0,

    // A refunded donation is reported separately.
    refundedAmountCents:
      funded || refunded
        ? Math.max(0, amountCents - netAmountCents)
        : 0,
  };
}

// ==========================================
// FETCH DONATION WITH RELATED DATA
// ==========================================

async function findDonationDetails(donationId: string) {
  return prisma.donation.findUnique({
    where: {
      id: donationId,
    },

    include: {
      donor: {
        select: {
          id: true,
          name: true,
        },
      },

      campaign: {
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              trustScore: true,
            },
          },

          milestones: {
            include: {
              evidence: {
                select: {
                  id: true,
                  reviewerDecision: true,
                  submittedAt: true,
                },
              },

              // One milestone has at most one payout.
              payout: {
                select: {
                  id: true,
                  amountCents: true,
                  status: true,
                },
              },
            },

            orderBy: {
              title: "asc",
            },
          },
        },
      },
    },
  });
}

// ==========================================
// DONATION ACCESS CONTROL
// ==========================================

function canAccessDonation(
  donation: NonNullable<
    Awaited<ReturnType<typeof findDonationDetails>>
  >,
  userId: string,
  role: string
): boolean {
  return (
    role === "reviewer" ||
    donation.donorId === userId ||
    donation.campaign.organizerId === userId
  );
}

// ==========================================
// GET /donations/:donationId/receipt
//
// Returns:
// - Donation amount and status
// - Campaign and organization
// - Milestone allocation
// - Verified versus pending amounts
// - Latest ledger hash
// ==========================================

router.get(
  "/:donationId/receipt",
  requireAuth,
  async (req, res) => {
    const donationId = req.params.donationId;

    if (typeof donationId !== "string") {
      return res.status(400).json({
        error: "Invalid donation ID",
      });
    }

    try {
      const donation =
        await findDonationDetails(donationId);

      if (!donation) {
        return res.status(404).json({
          error: "Donation not found",
        });
      }

      if (
        !canAccessDonation(
          donation,
          req.user!.id,
          req.user!.role
        )
      ) {
        return res.status(403).json({
          error: "You cannot access this donation",
        });
      }

      const netAmounts = await getNetDonationAmountsCents(
        prisma,
        [
          {
            id: donation.id,
            amountCents: donation.amountCents,
            status: donation.status,
            paypalCaptureId: donation.paypalCaptureId,
            currencyCode: donation.campaign.currency,
          },
        ]
      );

      const netAmountCents =
        netAmounts.get(donation.id) ?? 0;

      const refundedAmountCents =
        donation.status === "completed" ||
        donation.status === "refunded"
          ? Math.max(0, donation.amountCents - netAmountCents)
          : 0;

      const allocation = getMilestoneAllocations(
        donation.amountCents,
        donation.campaign.goalAmountCents,
        donation.campaign.milestones,
        donation.status,
        netAmountCents
      );

      // Latest hash from the global ledger.
      const latestLedgerEvent =
        await prisma.ledgerEvent.findFirst({
          orderBy: {
            createdAt: "desc",
          },

          select: {
            hash: true,
            createdAt: true,
          },
        });

      return res.status(200).json({
        donation: {
          id: donation.id,
          amountCents: donation.amountCents,
          netAmountCents,
          refundedAmountCents,
          currency: donation.campaign.currency,
          status: donation.status,
          paypalOrderId: donation.paypalOrderId,
          paypalCaptureId: donation.paypalCaptureId,
        },

        donor: donation.donor,

        campaign: {
          id: donation.campaign.id,
          title: donation.campaign.title,
          goalAmountCents:
            donation.campaign.goalAmountCents,
        },

        organization: donation.campaign.organization,

        allocation: {
          ...allocation,

          note:
            "Milestone amounts are estimated proportionally " +
            "from milestone budgets. They do not represent " +
            "actual PayPal fund segregation.",
        },

        ledger: {
          latestHash: latestLedgerEvent?.hash ?? null,
          createdAt:
            latestLedgerEvent?.createdAt ?? null,
        },
      });
    } catch (error) {
      console.error("Donation receipt error:", error);

      return res.status(500).json({
        error: "Failed to generate donation receipt",
      });
    }
  }
);

// ==========================================
// GET /donations/:donationId/trace
//
// Returns:
// - Donor
// - Donation
// - Campaign
// - Organization
// - Milestones
// - Evidence
// - Payouts
// - Related ledger events
// - Graph nodes and links
// ==========================================

router.get(
  "/:donationId/trace",
  requireAuth,
  async (req, res) => {
    const donationId = req.params.donationId;

    if (typeof donationId !== "string") {
      return res.status(400).json({
        error: "Invalid donation ID",
      });
    }

    try {
      const donation =
        await findDonationDetails(donationId);

      if (!donation) {
        return res.status(404).json({
          error: "Donation not found",
        });
      }

      if (
        !canAccessDonation(
          donation,
          req.user!.id,
          req.user!.role
        )
      ) {
        return res.status(403).json({
          error: "You cannot access this donation",
        });
      }

      const funded = donation.status === "completed";

      const netAmounts = await getNetDonationAmountsCents(
        prisma,
        [
          {
            id: donation.id,
            amountCents: donation.amountCents,
            status: donation.status,
            paypalCaptureId: donation.paypalCaptureId,
            currencyCode: donation.campaign.currency,
          },
        ]
      );

      const netAmountCents =
        netAmounts.get(donation.id) ?? 0;

      const refundedAmountCents =
        donation.status === "completed" ||
        donation.status === "refunded"
          ? Math.max(0, donation.amountCents - netAmountCents)
          : 0;

      const allocation = getMilestoneAllocations(
        donation.amountCents,
        donation.campaign.goalAmountCents,
        donation.campaign.milestones,
        donation.status,
        netAmountCents
      );

      // ==========================================
      // BASE GRAPH NODE IDS
      // ==========================================

      const donorNodeId =
        `donor:${donation.donor.id}`;

      const donationNodeId =
        `donation:${donation.id}`;

      const campaignNodeId =
        `campaign:${donation.campaign.id}`;

      const organizationNodeId =
        `organization:${donation.campaign.organization.id}`;

      // ==========================================
      // GRAPH NODES
      // ==========================================

      const nodes: Record<string, unknown>[] = [
        {
          id: donorNodeId,
          type: "donor",
          label: donation.donor.name,
        },

        {
          id: donationNodeId,
          type: "donation",
          label: "Donation",
          status: donation.status,
          amountCents: donation.amountCents,
          netAmountCents,
          refundedAmountCents,
        },

        {
          id: campaignNodeId,
          type: "campaign",
          label: donation.campaign.title,
          status: donation.campaign.status,
          goalAmountCents:
            donation.campaign.goalAmountCents,
        },

        {
          id: organizationNodeId,
          type: "organization",
          label: donation.campaign.organization.name,
          trustScore:
            donation.campaign.organization.trustScore,
        },
      ];

      // ==========================================
      // GRAPH LINKS
      // ==========================================

      const links: Record<string, unknown>[] = [
        {
          id: "donor-to-donation",
          source: donorNodeId,
          target: donationNodeId,
          type: "donated",
          amountCents: donation.amountCents,
        },

        {
          id: "donation-to-campaign",
          source: donationNodeId,
          target: campaignNodeId,
          type: "funded",
          amountCents: funded ? netAmountCents : 0,
        },

        {
          id: "campaign-to-organization",
          source: campaignNodeId,
          target: organizationNodeId,
          type: "belongs_to",
        },
      ];

      // Maps database entity IDs to graph node IDs.
      const entityNodeMap = new Map<string, string>([
        [donation.id, donationNodeId],
        [donation.campaign.id, campaignNodeId],
        [
          donation.campaign.organization.id,
          organizationNodeId,
        ],
      ]);

      // ==========================================
      // ADD MILESTONES, EVIDENCE AND PAYOUTS
      // ==========================================

      for (const item of allocation.allocations) {
        const milestone =
          donation.campaign.milestones.find(
            (entry) => entry.id === item.milestoneId
          );

        if (!milestone) {
          continue;
        }

        const milestoneNodeId =
          `milestone:${milestone.id}`;

        entityNodeMap.set(
          milestone.id,
          milestoneNodeId
        );

        nodes.push({
          id: milestoneNodeId,
          type: "milestone",
          label: milestone.title,
          status: milestone.status,
          budgetAmountCents:
            milestone.budgetAmountCents,
          allocatedAmountCents:
            item.allocatedAmountCents,
          verificationStatus:
            item.verificationStatus,
        });

        links.push({
          id: `campaign-milestone:${milestone.id}`,
          source: campaignNodeId,
          target: milestoneNodeId,
          type: "budget_attribution",
          amountCents: item.allocatedAmountCents,
          label: "Estimated allocation",
        });

        // Evidence nodes.
        for (const evidence of milestone.evidence) {
          const evidenceNodeId =
            `evidence:${evidence.id}`;

          entityNodeMap.set(
            evidence.id,
            evidenceNodeId
          );

          nodes.push({
            id: evidenceNodeId,
            type: "evidence",
            label: "Milestone evidence",
            status: evidence.reviewerDecision,
            submittedAt: evidence.submittedAt,
          });

          links.push({
            id: `milestone-evidence:${evidence.id}`,
            source: milestoneNodeId,
            target: evidenceNodeId,
            type: "supported_by",
          });
        }

        // A milestone now has zero or one payout.
        if (milestone.payout) {
          const payout = milestone.payout;

          const payoutNodeId =
            `payout:${payout.id}`;

          entityNodeMap.set(
            payout.id,
            payoutNodeId
          );

          nodes.push({
            id: payoutNodeId,
            type: "payout",
            label: "Milestone payout",
            amountCents: payout.amountCents,
            status: payout.status,
          });

          links.push({
            id: `milestone-payout:${payout.id}`,
            source: milestoneNodeId,
            target: payoutNodeId,
            type: "payout",
            amountCents: payout.amountCents,
          });
        }
      }

      // ==========================================
      // UNALLOCATED AMOUNT NODE
      // ==========================================

      if (allocation.unallocatedAmountCents > 0) {
        const unallocatedNodeId =
          `unallocated:${donation.id}`;

        nodes.push({
          id: unallocatedNodeId,
          type: "unallocated",
          label: "Not attributed to milestones",
          amountCents:
            allocation.unallocatedAmountCents,
        });

        links.push({
          id: "donation-unallocated",
          source: donationNodeId,
          target: unallocatedNodeId,
          type: "unallocated",
          amountCents:
            allocation.unallocatedAmountCents,
        });
      }

      // ==========================================
      // RELATED LEDGER EVENTS
      // ==========================================

      const ledgerEvents =
        await prisma.ledgerEvent.findMany({
          where: {
            entityId: {
              in: Array.from(entityNodeMap.keys()),
            },
          },

          orderBy: {
            createdAt: "asc",
          },

          select: {
            id: true,
            entityId: true,
            type: true,
            prevHash: true,
            hash: true,
            createdAt: true,
          },
        });

      for (const event of ledgerEvents) {
        const relatedNodeId =
          entityNodeMap.get(event.entityId);

        if (!relatedNodeId) {
          continue;
        }

        const eventNodeId =
          `ledger:${event.id}`;

        nodes.push({
          id: eventNodeId,
          type: "ledger_event",
          label: event.type,
          hash: event.hash,
          prevHash: event.prevHash,
          createdAt: event.createdAt,
        });

        links.push({
          id: `entity-ledger:${event.id}`,
          source: relatedNodeId,
          target: eventNodeId,
          type: "recorded_in_ledger",
        });
      }

      // ==========================================
      // LATEST LEDGER HASH
      // ==========================================

      const latestLedgerEvent =
        await prisma.ledgerEvent.findFirst({
          orderBy: {
            createdAt: "desc",
          },

          select: {
            hash: true,
            createdAt: true,
          },
        });

      return res.status(200).json({
        donationId: donation.id,

        allocationMethod:
          "proportional_to_milestone_budgets",

        allocationNote:
          "Milestone links represent estimated attribution, " +
          "not actual PayPal fund segregation.",

        nodes,

        links,

        ledger: {
          latestHash: latestLedgerEvent?.hash ?? null,
          createdAt:
            latestLedgerEvent?.createdAt ?? null,
          relatedEventCount: ledgerEvents.length,
        },
      });
    } catch (error) {
      console.error("Donation trace error:", error);

      return res.status(500).json({
        error: "Failed to generate donation trace",
      });
    }
  }
);

export default router;
