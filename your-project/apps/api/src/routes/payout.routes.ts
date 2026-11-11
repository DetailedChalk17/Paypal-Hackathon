import { Router } from "express";
import {
  requireAuth,
  requireRole,
} from "../middleware/auth.middleware";
import { prisma } from "../lib/prisma";
import { sendMockPayout } from "../services/payout.service";
import { appendEvent } from "../services/ledger.service";

const router = Router();

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

router.get("/failed", requireAuth, requireRole("reviewer"), async (_req, res) => {
  try {
    const payouts = await prisma.payout.findMany({
      where: { status: "failed" },
      include: {
        milestone: {
          include: {
            campaign: {
              include: { organization: { select: { name: true } } },
            },
          },
        },
      },
      orderBy: { id: "asc" },
    });

    return res.status(200).json(payouts);
  } catch (error) {
    console.error("Failed payout queue error:", error);
    return res.status(500).json({ error: "Unable to fetch failed payouts" });
  }
});

router.post("/:payoutId/retry", requireAuth, requireRole("reviewer"), async (req, res) => {
  const payoutId = req.params.payoutId;
  if (!isUuid(payoutId)) {
    return res.status(400).json({ error: "Invalid payout ID" });
  }

  try {
    const payout = await prisma.payout.findUnique({
      where: { id: payoutId },
    });

    if (!payout) return res.status(404).json({ error: "Payout not found" });
    if (payout.status !== "failed") {
      return res.status(409).json({ error: "Only failed payouts can be retried" });
    }

    await prisma.payout.update({
      where: { id: payout.id },
      data: { status: "processing" },
    });

    try {
      const result = await sendMockPayout({
        milestoneId: payout.milestoneId,
        amountCents: payout.amountCents,
      });

      const updatedPayout = await prisma.payout.update({
        where: { id: payout.id },
        data: {
          status: "paid",
          senderBatchId: result.senderBatchId,
        },
      });

      let ledgerRecorded = true;
      try {
        await appendEvent("PAYOUT_RETRIED", payout.id, {
          milestoneId: payout.milestoneId,
          amountCents: payout.amountCents,
          senderBatchId: result.senderBatchId,
        });
      } catch (ledgerError) {
        ledgerRecorded = false;
        console.error("Failed to record payout retry in ledger:", ledgerError);
      }

      return res.status(200).json({
        message: result.message,
        payout: updatedPayout,
        ledgerRecorded,
      });
    } catch (payoutError) {
      await prisma.payout.update({
        where: { id: payout.id },
        data: { status: "failed" },
      });
      console.error("Payout retry failed:", payoutError);
      return res.status(502).json({ error: "Unable to retry this payout" });
    }
  } catch (error) {
    console.error("Payout retry error:", error);
    return res.status(500).json({ error: "Unable to retry payout" });
  }
});

export default router;
