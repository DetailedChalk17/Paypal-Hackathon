
import { Router } from "express";

import {
  requireAuth,
  requireRole,
} from "../middleware/auth.middleware";

import { prisma } from "../lib/prisma";

import {
  recalculateOrganizationTrustScore,
} from "../services/trust-score.service";

const router = Router();

// ==========================================
// GET /organizations/:id/trust-score
// Retrieve saved trust score and breakdown
// ==========================================

router.get("/:organizationId/trust-score", async (req, res) => {
  const organizationId = req.params.organizationId;

  if (typeof organizationId !== "string") {
    return res.status(400).json({
      error: "Invalid organization ID",
    });
  }

  try {
    const organization = await prisma.organization.findUnique({
      where: {
        id: organizationId,
      },
      select: {
        id: true,
        name: true,
        trustScore: true,
        trustScoreBreakdown: true,
        trustScoreUpdatedAt: true,
      },
    });

    if (!organization) {
      return res.status(404).json({
        error: "Organization not found",
      });
    }

    return res.status(200).json({
      organizationId: organization.id,
      organizationName: organization.name,
      trustScore: organization.trustScore,
      breakdown: organization.trustScoreBreakdown,
      updatedAt: organization.trustScoreUpdatedAt,
    });
  } catch (error) {
    console.error("Get trust score error:", error);

    return res.status(500).json({
      error: "Failed to fetch trust score",
    });
  }
});

// ==========================================
// POST /organizations/:id/trust-score/recalculate
// Reviewer-only score recalculation
// ==========================================

router.post(
  "/:organizationId/trust-score/recalculate",
  requireAuth,
  requireRole("reviewer"),
  async (req, res) => {
    const organizationId = req.params.organizationId;

    if (typeof organizationId !== "string") {
      return res.status(400).json({
        error: "Invalid organization ID",
      });
    }

    try {
      const result =
        await recalculateOrganizationTrustScore(organizationId);

      return res.status(200).json(result);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Organization not found"
      ) {
        return res.status(404).json({
          error: "Organization not found",
        });
      }

      console.error("Recalculate trust score error:", error);

      return res.status(500).json({
        error: "Failed to recalculate trust score",
      });
    }
  }
);

export default router;
