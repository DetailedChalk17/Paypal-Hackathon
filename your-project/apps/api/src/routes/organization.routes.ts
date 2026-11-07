import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

const router = Router();

function getPositiveInt(
  value: unknown,
  fallback: number,
  max?: number
): number | null {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    (max !== undefined && parsed > max)
  ) {
    return null;
  }

  return parsed;
}

// ==========================================
// GET /organizations
// Marketplace with filters, sorting and pagination
// ==========================================

router.get("/", async (req, res) => {
  const page = getPositiveInt(req.query.page, 1);
  const limit = getPositiveInt(req.query.limit, 10, 50);

  if (page === null || limit === null) {
    return res.status(400).json({
      error: "Invalid page or limit",
    });
  }

  const { cause, location, q, sort } = req.query;

  if (
    [cause, location, q, sort].some(
      (value) => value !== undefined && typeof value !== "string"
    )
  ) {
    return res.status(400).json({
      error: "Invalid filter or sort parameter",
    });
  }

  const search = (q as string | undefined)?.trim();

  if (search && search.length > 100) {
    return res.status(400).json({
      error: "Search query cannot exceed 100 characters",
    });
  }

  const sortOption = (sort as string | undefined) || "trustScore";

  if (!["trustScore", "name", "cause", "location"].includes(sortOption)) {
    return res.status(400).json({
      error: "Invalid sort option",
    });
  }

  try {
    const where: Prisma.OrganizationWhereInput = {};

    if (typeof cause === "string" && cause.trim()) {
      where.cause = {
        contains: cause.trim(),
        mode: "insensitive",
      };
    }

    if (typeof location === "string" && location.trim()) {
      where.location = {
        contains: location.trim(),
        mode: "insensitive",
      };
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { cause: { contains: search, mode: "insensitive" } },
        { location: { contains: search, mode: "insensitive" } },
      ];
    }

    const orderBy: Prisma.OrganizationOrderByWithRelationInput[] =
      sortOption === "name"
        ? [{ name: "asc" }]
        : sortOption === "cause"
          ? [{ cause: "asc" }, { name: "asc" }]
          : sortOption === "location"
            ? [{ location: "asc" }, { name: "asc" }]
            : [{ trustScore: "desc" }, { name: "asc" }];

    const [organizations, total] = await Promise.all([
      prisma.organization.findMany({
        where,
        select: {
          id: true,
          name: true,
          cause: true,
          location: true,
          verified: true,
          trustScore: true,
          trustScoreUpdatedAt: true,
          _count: {
            select: {
              campaigns: true,
            },
          },
        },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),

      prisma.organization.count({ where }),
    ]);

    return res.status(200).json({
      organizations,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPreviousPage: page > 1,
      },
    });
  } catch (error) {
    console.error("Marketplace organizations error:", error);

    return res.status(500).json({
      error: "Failed to fetch organizations",
    });
  }
});

export default router;
