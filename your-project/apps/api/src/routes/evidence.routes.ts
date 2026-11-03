
import { Router } from "express";

import {
    requireAuth,
    requireRole,
} from "../middleware/auth.middleware";

import { prisma } from "../lib/prisma";

import { appendEvent } from "../services/ledger.service";

import { sendMockPayout } from "../services/payout.service";

const router = Router();

// GET /evidence/review-queue
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



// POST /evidence/:id/approve
router.post(
    "/:id/approve",
    requireAuth,
    requireRole("reviewer"),
    async (req, res) => {
        const evidenceId = req.params.id;

        if (typeof evidenceId !== "string") {
            return res.status(400).json({ error: "Invalid evidence ID" });
        }

        try {
            const evidence = await prisma.evidence.findUnique({
                where: { id: evidenceId },
                include: {
                    milestone: {
                        include: { campaign: true },
                    },
                },
            });

            if (!evidence) {
                return res.status(404).json({ error: "Evidence not found" });
            }

            if (evidence.milestone.campaign.organizerId === req.user!.id) {
                return res.status(403).json({
                    error: "Organizers cannot approve their own evidence",
                });
            }

            if (evidence.reviewerDecision !== "pending") {
                return res.status(400).json({
                    error: "Evidence has already been reviewed",
                });
            }

            if (evidence.milestone.status !== "evidence_submitted") {
                return res.status(400).json({
                    error: "Milestone is not awaiting review",
                });
            }

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

            await prisma.milestone.update({
                where: { id: evidence.milestoneId },
                data: { status: "approved" },
            });


            await appendEvent(
                "evidence_approved",
                evidenceId,
                {
                    milestoneId: evidence.milestoneId,
                    reviewerId: req.user!.id,
                }
            );

            // Create payout record
            const payout = await prisma.payout.create({
                data: {
                    milestoneId: evidence.milestoneId,
                    amountCents: evidence.milestone.budgetAmountCents,
                    status: "processing",
                },
            });

            // Call mocked PayPal payout
            try {
                const result = await sendMockPayout({
                    milestoneId: evidence.milestoneId,
                    amountCents: payout.amountCents,
                });

                if (!result.success) {
                    throw new Error("Mock payout failed");
                }

                const updatedPayout = await prisma.payout.update({
                    where: { id: payout.id },
                    data: {
                        status: "paid",
                        senderBatchId: result.senderBatchId,
                    },
                });

                await prisma.milestone.update({
                    where: { id: evidence.milestoneId },
                    data: { status: "paid" },
                });

                return res.status(200).json({
                    message: "Evidence approved and payout completed",
                    payout: updatedPayout,
                });
            } catch (error) {
                console.error("Payout error:", error);

                await prisma.payout.update({
                    where: { id: payout.id },
                    data: { status: "failed" },
                });

                return res.status(502).json({
                    error: "Evidence approved, but payout failed",
                });
            }

        } catch (error) {
            console.error("Evidence approval error:", error);

            return res.status(500).json({
                error: "Failed to approve evidence",
            });
        }
    }
);

// POST /evidence/:id/reject
router.post(
    "/:id/reject",
    requireAuth,
    requireRole("reviewer"),
    async (req, res) => {
        const evidenceId = req.params.id;

        if (typeof evidenceId !== "string") {
            return res.status(400).json({ error: "Invalid evidence ID" });
        }

        try {
            const evidence = await prisma.evidence.findUnique({
                where: { id: evidenceId },
                include: { milestone: true },
            });

            if (!evidence) {
                return res.status(404).json({ error: "Evidence not found" });
            }
            if (evidence.milestone.status !== "evidence_submitted") {
                return res.status(400).json({
                    error: "Milestone is not awaiting review",
                });
            }
            if (evidence.reviewerDecision !== "pending") {
                return res.status(400).json({
                    error: "Evidence has already been reviewed",
                });
            }

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

            await prisma.milestone.update({
                where: { id: evidence.milestoneId },
                data: { status: "rejected" },
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
