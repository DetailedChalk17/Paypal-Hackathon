
import { Router } from "express";

import {
  requireAuth,
  requireRole,
} from "../middleware/auth.middleware";

import { prisma } from "../lib/prisma";

import {
  recalculateOrganizationTrustScore,
} from "../services/trust-score.service";
import { UpdateOrganizationPayoutEmailSchema } from "@your-project/shared";

const router = Router();

router.patch(
  "/:organizationId/payout-email",
  requireAuth,
  requireRole("organizer"),
  async (req, res) => {
    const organizationId = req.params.organizationId;
    const parsed = UpdateOrganizationPayoutEmailSchema.safeParse(req.body);

    if (
      typeof organizationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId) ||
      !parsed.success
    ) {
      return res.status(400).json({ error: "Invalid organization payout email" });
    }

    try {
      const campaign = await prisma.campaign.findFirst({
        where: {
          organizationId,
          organizerId: req.user!.id,
        },
        select: { id: true },
      });

      if (!campaign) {
        return res.status(403).json({
          error: "You cannot update this organization's payout email",
        });
      }

      const organization = await prisma.organization.update({
        where: { id: organizationId },
        data: { payoutEmail: parsed.data.payoutEmail },
        select: { id: true, payoutEmail: true },
      });

      return res.status(200).json(organization);
    } catch (error) {
      console.error("Update organization payout email error:", error);

      return res.status(500).json({
        error: "Failed to update organization payout email",
      });
    }
  },
);

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
