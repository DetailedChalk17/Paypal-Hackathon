
import { Router } from "express";

import {
  requireAuth,
  requireRole,
} from "../middleware/auth.middleware";

import { prisma } from "../lib/prisma";

import { appendEvent } from "../services/ledger.service";
import { releasePayout } from "../services/payout.service";
import { recalculateOrganizationTrustScore } from "../services/trust-score.service";

const router = Router();

// ==========================================
// GET /evidence/review-queue
// Fetch evidence awaiting reviewer approval
// ==========================================

router.get(
  "/review-queue",
  requireAuth,
  requireRole("reviewer"),
  async (_req, res) => {
    try {
      const evidence = await prisma.evidence.findMany({
        where: {
          reviewerDecision: "pending",
        },
        include: {
          milestone: {
            include: {
              campaign: {
                include: {
                  organization: true,
                },
              },
            },
          },
        },
        orderBy: {
          id: "desc",
        },
      });

      return res.status(200).json(evidence);
    } catch (error) {
      console.error("Reviewer queue error:", error);

      return res.status(500).json({
        error: "Failed to fetch review queue",
      });
    }
  }
);

// ==========================================
// POST /evidence/:id/approve
// Approve evidence and initiate milestone payout
// ==========================================

router.post(
  "/:id/approve",
  requireAuth,
  requireRole("reviewer"),
  async (req, res) => {
    const evidenceId = req.params.id;

    if (typeof evidenceId !== "string") {
      return res.status(400).json({
        error: "Invalid evidence ID",
      });
    }

    try {
      // 1. Find evidence and its associated milestone.
      const evidence = await prisma.evidence.findUnique({
        where: {
          id: evidenceId,
        },
        include: {
          milestone: {
            include: {
              campaign: true,
            },
          },
        },
      });

      if (!evidence) {
        return res.status(404).json({
          error: "Evidence not found",
        });
      }

      // 2. Organizers cannot approve their own evidence.
      if (
        evidence.milestone.campaign.organizerId ===
        req.user!.id
      ) {
        return res.status(403).json({
          error: "Organizers cannot approve their own evidence",
        });
      }

      // 3. Check whether evidence has already been reviewed.
      if (evidence.reviewerDecision !== "pending") {
        return res.status(400).json({
          error: "Evidence has already been reviewed",
        });
      }

      if (
        evidence.milestone.status !== "evidence_submitted"
      ) {
        return res.status(400).json({
          error: "Milestone is not awaiting review",
        });
      }

      // 4. Atomically claim the pending evidence.
      const claimed = await prisma.evidence.updateMany({
        where: {
          id: evidenceId,
          reviewerDecision: "pending",
          milestone: {
            status: "evidence_submitted",
          },
        },
        data: {
          reviewerDecision: "approved",
        },
      });

      if (claimed.count === 0) {
        return res.status(409).json({
          error: "Evidence has already been reviewed",
        });
      }

      // 5. Update milestone status to approved.
      await prisma.milestone.update({
        where: {
          id: evidence.milestoneId,
        },
        data: {
          status: "approved",
        },
      });

      // 6. Record evidence approval in the ledger.
      await appendEvent(
        "evidence_approved",
        evidenceId,
        {
          milestoneId: evidence.milestoneId,
          reviewerId: req.user!.id,
        }
      );

      // 7. Initiate payout through centralized service.
      let payout;

      try {
        payout = await releasePayout(
          evidence.milestoneId
        );
      } catch (error) {
        console.error("Payout submission error:", error);

        return res.status(502).json({
          message:
            "Evidence approved, but payout submission failed",
          error:
            error instanceof Error
              ? error.message
              : "Unknown payout error",
          milestoneId: evidence.milestoneId,
        });
      }

      // 8. Refresh organization's trust score.
      const trustScore =
        await recalculateOrganizationTrustScore(
          evidence.milestone.campaign.organizationId
        );

      // 9. Return payout information.
      return res.status(200).json({
        message: "Evidence approved and payout submitted",
        evidenceId,
        milestoneId: evidence.milestoneId,
        payout,
        trustScore,
      });
    } catch (error) {
      console.error("Evidence approval error:", error);

      return res.status(500).json({
        error: "Failed to complete evidence approval",
      });
    }
  }
);

// ==========================================
// POST /evidence/:id/retry-payout
// Retry an existing failed milestone payout
// ==========================================

router.post(
  "/:id/retry-payout",
  requireAuth,
  requireRole("reviewer"),
  async (req, res) => {
    const evidenceId = req.params.id;

    if (typeof evidenceId !== "string") {
      return res.status(400).json({
        error: "Invalid evidence ID",
      });
    }

    try {
      // 1. Find evidence and its associated milestone.
      const evidence = await prisma.evidence.findUnique({
        where: {
          id: evidenceId,
        },
        include: {
          milestone: {
            include: {
              campaign: true,
            },
          },
        },
      });

      if (!evidence) {
        return res.status(404).json({
          error: "Evidence not found",
        });
      }

      // 2. Apply the same organizer restriction as approval.
      if (
        evidence.milestone.campaign.organizerId ===
        req.user!.id
      ) {
        return res.status(403).json({
          error: "Organizers cannot retry their own milestone payout",
        });
      }

      // 3. Evidence must already have been approved.
      if (evidence.reviewerDecision !== "approved") {
        return res.status(400).json({
          error: "Evidence must be approved before retrying payout",
        });
      }

      // 4. Milestone must remain approved.
      if (evidence.milestone.status !== "approved") {
        return res.status(400).json({
          error: "Milestone is not eligible for payout retry",
        });
      }

      // 5. Find the existing payout.
      // This endpoint must NEVER create another payout.
      const existingPayout = await prisma.payout.findUnique({
        where: {
          milestoneId: evidence.milestoneId,
        },
      });

      if (!existingPayout) {
        return res.status(409).json({
          error: "No existing payout is available to retry",
        });
      }

      // 6. Only failed payouts can be retried.
      if (existingPayout.status !== "failed") {
        return res.status(409).json({
          error: "Only failed payouts can be retried",
          payoutStatus: existingPayout.status,
        });
      }

      // 7. Reuse the existing payout record.
      // releasePayout handles atomic retry claiming and
      // preserves the original senderBatchId.
      const payout = await releasePayout(
        evidence.milestoneId
      );

      return res.status(200).json({
        message: "Payout retry accepted",
        evidenceId,
        milestoneId: evidence.milestoneId,
        payout,
      });
    } catch (error) {
      console.error("Payout retry error:", error);

      return res.status(502).json({
        message: "Payout retry failed",
        error:
          error instanceof Error
            ? error.message
            : "Unknown payout error",
      });
    }
  }
);

// ==========================================
// POST /evidence/:id/reject
// Reject submitted milestone evidence
// ==========================================

router.post(
  "/:id/reject",
  requireAuth,
  requireRole("reviewer"),
  async (req, res) => {
    const evidenceId = req.params.id;

    if (typeof evidenceId !== "string") {
      return res.status(400).json({
        error: "Invalid evidence ID",
      });
    }

    try {
      // 1. Find evidence and associated milestone.
      const evidence = await prisma.evidence.findUnique({
        where: {
          id: evidenceId,
        },
        include: {
          milestone: true,
        },
      });

      if (!evidence) {
        return res.status(404).json({
          error: "Evidence not found",
        });
      }

      // 2. Check milestone review status.
      if (
        evidence.milestone.status !== "evidence_submitted"
      ) {
        return res.status(400).json({
          error: "Milestone is not awaiting review",
        });
      }

      if (evidence.reviewerDecision !== "pending") {
        return res.status(400).json({
          error: "Evidence has already been reviewed",
        });
      }

      // 3. Atomically claim the pending evidence.
      const claimed = await prisma.evidence.updateMany({
        where: {
          id: evidenceId,
          reviewerDecision: "pending",
          milestone: {
            status: "evidence_submitted",
          },
        },
        data: {
          reviewerDecision: "rejected",
        },
      });

      if (claimed.count === 0) {
        return res.status(409).json({
          error: "Evidence has already been reviewed",
        });
      }

      // 4. Update milestone status.
      await prisma.milestone.update({
        where: {
          id: evidence.milestoneId,
        },
        data: {
          status: "rejected",
        },
      });

      return res.status(200).json({
        message: "Evidence rejected",
      });
    } catch (error) {
      console.error("Evidence rejection error:", error);

      return res.status(500).json({
        error: "Failed to reject evidence",
      });
    }
  }
);

export default router;
