
import { Router } from "express";
import { unlink } from "node:fs/promises";

import {
    requireAuth,
    requireRole,
} from "../middleware/auth.middleware";

import { uploadEvidence } from "../middleware/upload.middleware";
import { prisma } from "../lib/prisma";

import { analyzeWithTimeout } from "../services/ai.service";

const router = Router();

// POST /milestones/:milestoneId/evidence
router.post(
    "/:milestoneId/evidence",
    requireAuth,
    requireRole("organizer"),
    uploadEvidence.single("file"),
    async (req, res) => {
        const milestoneId = req.params.milestoneId;

        if (typeof milestoneId !== "string") {
            return res.status(400).json({
                error: "Invalid milestone ID",
            });
        }

        const file = req.file;

        if (!file) {
            return res.status(400).json({
                error: "Evidence file is required",
            });
        }

        try {
            const milestone = await prisma.milestone.findUnique({
                where: { id: milestoneId },
                include: {
                    campaign: true,
                },
            });

            if (!milestone) {
                await unlink(file.path).catch(() => { });

                return res.status(404).json({
                    error: "Milestone not found",
                });
            }

            if (milestone.campaign.organizerId !== req.user!.id) {
                await unlink(file.path).catch(() => { });

                return res.status(403).json({
                    error: "You cannot upload evidence for this milestone",
                });
            }

            if (milestone.status !== "open") {
                await unlink(file.path).catch(() => { });

                return res.status(400).json({
                    error: "Evidence can only be uploaded to open milestones",
                });
            }

            const evidence = await prisma.$transaction(async (tx) => {
                const created = await tx.evidence.create({
                    data: {
                        milestoneId,
                        file: file.filename,
                        extractedFields: {},
                        aiFindings: {
                            status: "pending",
                        },
                    },
                });

                const claimed = await tx.milestone.updateMany({
                    where: {
                        id: milestoneId,
                        status: "open",
                    },
                    data: {
                        status: "evidence_submitted",
                    },
                });

                if (claimed.count === 0) {
                    throw new Error("Milestone is no longer open");
                }

                return created;
            });
            let aiFindings;

            try {
                aiFindings = await analyzeWithTimeout(file.path);
            } catch (error) {
                aiFindings = {
                    status: "failed",
                    message:
                        error instanceof Error
                            ? error.message
                            : "AI analysis failed",
                };
            }

            const updatedEvidence = await prisma.evidence.update({
                where: {
                    id: evidence.id,
                },
                data: {
                    aiFindings,
                },
            });

            return res.status(201).json({
                message: "Evidence uploaded successfully",
                evidence: updatedEvidence,
            });
        } catch (error) {
            await unlink(file.path).catch(() => { });

            console.error("Evidence upload error:", error);

            return res.status(500).json({
                error: "Failed to upload evidence",
            });
        }
    }
);

export default router;
