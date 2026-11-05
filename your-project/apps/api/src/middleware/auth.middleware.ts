
import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import type { User } from "@your-project/shared";

const AUTH_COOKIE_NAME = "impactledger_token";

export const optionalAuth: RequestHandler = async (req, res, next) => {
  const token: unknown = req.cookies?.[AUTH_COOKIE_NAME];
  if (typeof token !== "string") {
    next();
    return;
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error("JWT_SECRET is not configured.");
    res.status(500).json({ error: "Authentication is not configured." });
    return;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);
    if (typeof decoded === "string" || typeof decoded.sub !== "string") {
      next();
      return;
    }

    req.user = await prisma.user.findUnique({
      where: { id: decoded.sub },
      select: { id: true, name: true, email: true, role: true },
    }) ?? undefined;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      next();
      return;
    }

    console.error("Optional authentication error:", error);
    res.status(500).json({ error: "Unable to authenticate request." });
  }
};

// Checks whether the request has a valid login session
export const requireAuth: RequestHandler = async (req, res, next) => {
  const token: unknown = req.cookies?.[AUTH_COOKIE_NAME];

  if (typeof token !== "string") {
    res.status(401).json({
      error: "Authentication required. Please log in.",
    });
    return;
  }

  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    console.error("JWT_SECRET is not configured.");

    res.status(500).json({
      error: "Authentication is not configured.",
    });
    return;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret);

    if (typeof decoded === "string" || typeof decoded.sub !== "string") {
      res.status(401).json({
        error: "Invalid authentication token.",
      });
      return;
    }

    // Verify that this user still exists in the database
    const user = await prisma.user.findUnique({
      where: {
        id: decoded.sub,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    });

    if (!user) {
      res.status(401).json({
        error: "User no longer exists. Please log in again.",
      });
      return;
    }

    req.user = user;
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        error: "Invalid or expired authentication token.",
      });
      return;
    }

    console.error("Authentication error:", error);

    res.status(500).json({
      error: "Unable to authenticate request.",
    });
  }
};

// Checks whether the logged-in user has the required role
export const requireRole = (
  ...allowedRoles: User["role"][]
): RequestHandler => {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({
        error: "Authentication required.",
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: "You do not have permission to access this resource.",
      });
      return;
    }

    next();
  };
};
