import path from "node:path";
import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config();

import multer from "multer";
import express, {
  Request,
  Response,
  NextFunction,
} from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

import { prisma } from "./lib/prisma";

import authRoutes from "./routes/auth.routes";
import campaignRoutes from "./routes/campaign.routes";
import milestoneEvidenceRoutes from "./routes/milestone-evidence.routes";
import evidenceRoutes from "./routes/evidence.routes";
import evidenceFileRoutes from "./routes/evidence-files.routes";
import ledgerRoutes from "./routes/ledger.routes";
import trustScoreRoutes from "./routes/trust-score.routes";
import donationDataRoutes from "./routes/donation-data.routes";
import donationPaymentRoutes from "./routes/donation-payment.routes";
import paypalWebhookRoutes from "./routes/paypal-webhook.routes";
import organizationRoutes from "./routes/organization.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import routingRoutes from "./routes/routing.routes";

import payoutRoutes from "./routes/payout.routes";

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const allowedOrigins = [
  ...(process.env.FRONTEND_URL ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  ...(process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"]),
];

// Render runs the application behind a reverse proxy.
app.set("trust proxy", 1);

// ==========================================
// SECURITY MIDDLEWARE
// ==========================================

app.use(helmet());

// ==========================================
// REQUEST LOGGING
// ==========================================

app.use((req, res, next) => {
  const startTime = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - startTime;

    console.log(
      `${req.method} ${req.path} ${res.statusCode} ${duration}ms`
    );
  });

  next();
});

// ==========================================
// PAYPAL WEBHOOKS
// Must run before JSON body parsing.
// ==========================================

app.use("/webhooks", paypalWebhookRoutes);

// ==========================================
// GENERAL MIDDLEWARE
// ==========================================

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.sendStatus(204);
  }

  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/health", (_req, res) => {
  return res.status(200).json({
    status: "ok",
    service: "impactledger-api",
    message: "ImpactLedger API is running",
  });
});

// ==========================================
// DATABASE HEALTH CHECK
// ==========================================

app.get("/health/db", async (_req, res) => {
  try {
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

// ==========================================
// API RATE LIMITING
// ==========================================

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please try again later.",
  },
});

app.use(apiLimiter);

// ==========================================
// API ROUTES
// ==========================================

app.use("/auth", authRoutes);
app.use("/campaigns", campaignRoutes);
app.use("/milestones", milestoneEvidenceRoutes);
app.use("/evidence", evidenceRoutes);
app.use("/evidence-files", evidenceFileRoutes);
app.use("/ledger", ledgerRoutes);

// B6: Trust score
app.use("/organizations", trustScoreRoutes);

// PayPal donations
app.get(["/donations/return", "/paypal/return"], (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
  const query = new URLSearchParams(req.query as any).toString();
  return res.redirect(`${frontendUrl}/paypal/return?${query}`);
});
app.use("/donations", donationPaymentRoutes);

// B6: Donation receipt and trace
app.use("/donations", donationDataRoutes);
app.use("/organizations", organizationRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/routing", routingRoutes);
app.use("/payouts", payoutRoutes);

// ==========================================
// FRONTEND STATIC SERVING (PRODUCTION)
// ==========================================
const webDistPath = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDistPath)) {
  app.use(express.static(webDistPath));
  app.use((req, res, next) => {
    const isHtmlRequest = Boolean(req.headers.accept?.includes("text/html"));
    const isApiRequest =
      req.path.startsWith("/auth") ||
      req.path.startsWith("/campaigns") ||
      req.path.startsWith("/donations") ||
      req.path.startsWith("/evidence") ||
      req.path.startsWith("/evidence-files") ||
      req.path.startsWith("/ledger") ||
      req.path.startsWith("/organizations") ||
      req.path === "/dashboard/summary" ||
      req.path.startsWith("/routing") ||
      req.path.startsWith("/payouts") ||
      req.path.startsWith("/health");

    if (req.method !== "GET" || (isApiRequest && !isHtmlRequest)) {
      return next();
    }
    return res.sendFile(path.join(webDistPath, "index.html"));
  });
}

// ==========================================
// CENTRALIZED ERROR HANDLING
// ==========================================

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

// ==========================================
// START SERVER
// ==========================================

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(
      `ImpactLedger API running at http://localhost:${PORT}`
    );
  });
}

export { app };
export default app;
