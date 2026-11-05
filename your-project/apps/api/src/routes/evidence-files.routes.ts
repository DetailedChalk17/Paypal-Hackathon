import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();
const uploadDirectory = path.resolve(__dirname, "../../../uploads");

router.get("/:evidenceId", requireAuth, async (req, res) => {
  const evidenceId = req.params.evidenceId;

  if (
    typeof evidenceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evidenceId)
  ) {
    return res.status(400).json({ error: "Invalid evidence ID" });
  }

  try {
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      include: { milestone: { include: { campaign: true } } },
    });

    if (!evidence) return res.status(404).json({ error: "Evidence not found" });
    if (
      req.user!.role !== "reviewer" &&
      evidence.milestone.campaign.organizerId !== req.user!.id
    ) {
      return res.status(403).json({ error: "You cannot access this evidence file" });
    }

    const filename = path.basename(evidence.file);
    if (!filename || filename !== evidence.file) {
      return res.status(404).json({ error: "Evidence file not found" });
    }

    const filePath = path.resolve(uploadDirectory, filename);
    if (path.dirname(filePath) !== uploadDirectory) {
      return res.status(404).json({ error: "Evidence file not found" });
    }

    const extension = path.extname(filename).toLowerCase();
    const contentType =
      extension === ".jpg" || extension === ".jpeg"
        ? "image/jpeg"
        : extension === ".png"
          ? "image/png"
          : extension === ".pdf"
            ? "application/pdf"
            : null;

    if (!contentType) return res.status(404).json({ error: "Evidence file not found" });

    try {
      await fs.access(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return res.status(404).json({ error: "Evidence file not found" });
      }
      throw error;
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.sendFile(filePath);
  } catch (error) {
    console.error("Evidence file retrieval failed:", error);
    return res.status(500).json({ error: "Unable to retrieve evidence file" });
  }
});

export default router;
