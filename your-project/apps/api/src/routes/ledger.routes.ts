
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { verifyChain } from "../services/ledger.service";

const router = Router();

// GET /ledger/verify
// Verify the complete ledger hash chain.
router.get("/verify", async (_req, res) => {
  try {
    const result = await verifyChain();

    return res.status(200).json(result);
  } catch (error) {
    console.error("Ledger verification failed:", error);

    return res.status(500).json({
      error: "Unable to verify ledger.",
    });
  }
});

// GET /ledger/latest-hash
// Return the latest event hash.
router.get("/latest-hash", async (_req, res) => {
  try {
    const latestEvent = await prisma.ledgerEvent.findFirst({
      orderBy: {
        createdAt: "desc",
      },
      select: {
        hash: true,
        createdAt: true,
      },
    });

    return res.status(200).json({
      latestHash: latestEvent?.hash ?? null,
      createdAt: latestEvent?.createdAt ?? null,
    });
  } catch (error) {
    console.error("Fetching latest ledger hash failed:", error);

    return res.status(500).json({
      error: "Unable to fetch latest ledger hash.",
    });
  }
});

export default router;
