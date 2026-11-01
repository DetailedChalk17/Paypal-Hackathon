
import { Router } from "express";
import jwt from "jsonwebtoken";

import { UserSchema } from "@your-project/shared";
import { prisma } from "../lib/prisma";
import {
  requireAuth,
  requireRole,
} from "../middleware/auth.middleware";

const router = Router();

const demoLoginSchema = UserSchema.pick({
  role: true,
});

const AUTH_COOKIE_NAME = "impactledger_token";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;

// POST /auth/demo-login
router.post("/demo-login", async (req, res) => {
  // 1. Validate the requested role
  const parsed = demoLoginSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid login request",
      details: parsed.error.flatten(),
    });
  }

  try {
    // 2. Find the pre-created demo user
    const user = await prisma.user.findFirst({
      where: {
        role: parsed.data.role,
      },
      orderBy: {
        email: "asc",
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    });

    if (!user) {
      return res.status(404).json({
        error: "No demo user found for this role. Run the seed script first.",
      });
    }

    // 3. Check JWT configuration
    const jwtSecret = process.env.JWT_SECRET;

    if (!jwtSecret) {
      return res.status(500).json({
        error: "Authentication is not configured on the server.",
      });
    }

    // 4. Generate JWT
    const token = jwt.sign(
      { role: user.role },
      jwtSecret,
      {
        subject: user.id,
        expiresIn: SESSION_DURATION_SECONDS,
      }
    );

    // 5. Store JWT in an HTTP-only cookie
    res.cookie(AUTH_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_DURATION_SECONDS * 1000,
      path: "/",
    });

    // 6. Return user information
    return res.status(200).json({
      message: "Demo login successful",
      user,
    });

  } catch (error) {
    console.error("Demo login failed:", error);

    return res.status(500).json({
      error: "Unable to complete demo login.",
    });
  }
});

// POST /auth/logout
router.post("/logout", (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });

  return res.status(200).json({
    message: "Logged out successfully",
  });
});

// GET /auth/me
// Returns the currently authenticated user
router.get("/me", requireAuth, (req, res) => {
  if (!req.user) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  return res.status(200).json({
    user: req.user,
  });
});

// GET /auth/reviewer-check
// Temporary endpoint to test role-based access
router.get(
  "/reviewer-check",
  requireAuth,
  requireRole("reviewer"),
  (_req, res) => {
    return res.status(200).json({
      message: "Reviewer access granted",
    });
  }
);

export default router;
