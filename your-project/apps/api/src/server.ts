
import express from "express";
import cookieParser from "cookie-parser";
import { prisma } from "./lib/prisma";
import authRoutes from "./routes/auth.routes";

const app = express();

const PORT = Number(process.env.PORT) || 3000;

// Middleware
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Authentication routes
app.use("/auth", authRoutes);

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

// Start server
app.listen(PORT, () => {
  console.log(
    `ImpactLedger API running at http://localhost:${PORT}`
  );
});
