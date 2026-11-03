import multer from "multer";
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { prisma } from "./lib/prisma";
import authRoutes from "./routes/auth.routes";
import campaignRoutes from "./routes/campaign.routes";
import milestoneEvidenceRoutes from "./routes/milestone-evidence.routes";
import evidenceRoutes from "./routes/evidence.routes";
import ledgerRoutes from "./routes/ledger.routes";

const app = express();

const PORT = Number(process.env.PORT) || 3000;

// Middleware
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Authentication routes
app.use("/auth", authRoutes);
app.use("/campaigns", campaignRoutes);
app.use("/milestones", milestoneEvidenceRoutes);
app.use("/evidence", evidenceRoutes);
app.use("/ledger", ledgerRoutes);

// Basic API health check
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "impactledger-api",
    message: "ImpactLedger API is running",
  });
});

// Database health check
app.get("/health/db", async (_req, res) => {
  try {
    // Execute a real query against PostgreSQL
    await prisma.$queryRaw`SELECT 1`;

    return res.status(200).json({
      status: "ok",
      service: "impactledger-api",
      database: "connected",
    });
  } catch (error) {
    console.error("Database health check failed:", error);

    return res.status(503).json({
      status: "error",
      service: "impactledger-api",
      database: "disconnected",
    });
  }
});
// Centralized error handling
app.use((
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "File size cannot exceed 5 MB",
      });
    }

    return res.status(400).json({
      error: "File upload failed",
    });
  }

  if (
    error instanceof Error &&
    error.message === "Only JPG, PNG and PDF files are allowed"
  ) {
    return res.status(400).json({
      error: error.message,
    });
  }

  console.error("Unhandled server error:", error);

  return res.status(500).json({
    error: "Internal server error",
  });
});
// Start server
app.listen(PORT, () => {
  console.log(
    `ImpactLedger API running at http://localhost:${PORT}`
  );
});
