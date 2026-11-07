import { Router } from "express";

import {
  requireAuth,
  requireRole,
} from "../middleware/auth.middleware";

import { prisma } from "../lib/prisma";
import { appendEvent } from "../services/ledger.service";
import { parseDonationRequest, routeDonation } from "../services/ai.service";

const router = Router();

function isValidUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

// ==========================================
// POST /donations/create-order
// Create a donation and its PayPal order
// ==========================================

router.post(
  "/create-order",
  requireAuth,
  requireRole("donor"),
  async (req, res) => {
    const { campaignId, amountCents } = req.body ?? {};

    if (!isValidUuid(campaignId)) {
      return res.status(400).json({
        error: "Invalid campaign ID",
      });
    }

    if (
      !Number.isSafeInteger(amountCents) ||
      amountCents <= 0
    ) {
      return res.status(400).json({
        error: "Donation amount must be a positive number of cents",
      });
    }

    try {
      // 1. Check that the campaign exists and accepts donations.
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: {
          id: true,
          status: true,
          currency: true,
        },
      });

      if (!campaign) {
        return res.status(404).json({
          error: "Campaign not found",
        });
      }

      if (campaign.status !== "active") {
        return res.status(409).json({
          error: "This campaign is not accepting donations",
        });
      }

      if (campaign.currency !== "USD") {
        return res.status(400).json({
          error: "Only USD donations are supported",
        });
      }

      // 2. Create a pending donation for the logged-in donor.
      const donation = await prisma.donation.create({
        data: {
          campaignId,
          donorId: req.user!.id,
          amountCents,
          status: "pending",
        },
      });

      try {
        // 3. Load the PayPal package and create the order.
        const { createOrder } = await import(
          "@your-project/paypal"
        );

        const order = await createOrder({
          campaignId,
          amountCents,
          // Stable for retries of this donation's order request.
          requestId: donation.id,
        });

        // 4. Save the PayPal Order ID.
        await prisma.donation.update({
          where: { id: donation.id },
          data: {
            paypalOrderId: order.orderId,
          },
        });

        // 5. Record the order creation in the ledger.
        let ledgerRecorded = true;

        try {
          await appendEvent(
            "DONATION_ORDER_CREATED",
            donation.id,
            {
              campaignId,
              donorId: req.user!.id,
              amountCents,
              paypalOrderId: order.orderId,
            }
          );
        } catch (ledgerError) {
          ledgerRecorded = false;
          console.error(
            "Failed to record donation order in ledger:",
            ledgerError
          );
        }

        return res.status(201).json({
          donationId: donation.id,
          orderId: order.orderId,
          approvalUrl: order.approvalUrl,
          status: "pending",
          ledgerRecorded,
        });
      } catch (paypalError) {
        // PayPal order creation failed.
        await prisma.donation.update({
          where: { id: donation.id },
          data: { status: "failed" },
        });

        try {
          await appendEvent(
            "DONATION_ORDER_FAILED",
            donation.id,
            {
              campaignId,
              amountCents,
            }
          );
        } catch (ledgerError) {
          console.error("Failed to record order failure:", ledgerError);
        }

        throw paypalError;
      }
    } catch (error) {
      console.error("Create donation order error:", error);

      return res.status(502).json({
        error: "Unable to create PayPal donation order",
      });
    }
  }
);

// ==========================================
// POST /donations/:donationId/capture
// Capture an approved PayPal order
// ==========================================

router.post(
  "/:donationId/capture",
  requireAuth,
  requireRole("donor"),
  async (req, res) => {
    const { donationId } = req.params;

    if (!isValidUuid(donationId)) {
      return res.status(400).json({
        error: "Invalid donation ID",
      });
    }

    try {
      // 1. Find the donation.
      const donation = await prisma.donation.findUnique({
        where: { id: donationId },
      });

      if (!donation) {
        return res.status(404).json({
          error: "Donation not found",
        });
      }

      // 2. Only the donor who created it can capture it.
      if (donation.donorId !== req.user!.id) {
        return res.status(403).json({
          error: "You cannot capture this donation",
        });
      }

      // 3. Make repeated capture requests safe.
      if (donation.status === "completed") {
        return res.status(200).json({
          donationId: donation.id,
          orderId: donation.paypalOrderId,
          captureId: donation.paypalCaptureId,
          status: "completed",
          alreadyCaptured: true,
        });
      }

      if (
        donation.status !== "pending" ||
        !donation.paypalOrderId
      ) {
        return res.status(409).json({
          error: "Donation cannot be captured",
        });
      }

      // 4. Capture through PayPal.
      const { captureOrder } = await import(
        "@your-project/paypal"
      );

      const result = await captureOrder({
        orderId: donation.paypalOrderId,
        expectedAmountCents: donation.amountCents,
        requestId: `c-${donation.id}`,
      });

      // 5. Handle successful capture.
      if (result.captureStatus === "COMPLETED") {
        const updatedDonation = await prisma.donation.update({
          where: { id: donation.id },
          data: {
            paypalCaptureId: result.captureId,
            status: "completed",
          },
        });

        let ledgerRecorded = true;

        try {
          await appendEvent(
            "DONATION_COMPLETED",
            donation.id,
            {
              paypalOrderId: result.orderId,
              paypalCaptureId: result.captureId,
              amountCents: result.amountCents,
              currencyCode: result.currencyCode,
            }
          );
        } catch (ledgerError) {
          ledgerRecorded = false;
          console.error(
            "Failed to record completed donation in ledger:",
            ledgerError
          );
        }

        return res.status(200).json({
          donationId: updatedDonation.id,
          orderId: result.orderId,
          captureId: result.captureId,
          amountCents: result.amountCents,
          status: updatedDonation.status,
          ledgerRecorded,
        });
      }

      // 6. PayPal reports that capture is still pending.
      if (result.captureStatus === "PENDING") {
        await prisma.donation.update({
          where: { id: donation.id },
          data: {
            paypalCaptureId: result.captureId,
          },
        });

        return res.status(202).json({
          donationId: donation.id,
          captureId: result.captureId,
          status: "pending",
          message: "Payment capture is still processing",
        });
      }

      // 7. PayPal explicitly denied the capture.
      if (result.captureStatus === "DENIED") {
        await prisma.donation.update({
          where: { id: donation.id },
          data: { status: "failed" },
        });

        try {
          await appendEvent(
            "DONATION_CAPTURE_DENIED",
            donation.id,
            {
              paypalOrderId: result.orderId,
              paypalCaptureId: result.captureId,
            }
          );
        } catch (ledgerError) {
          console.error("Failed to record denied capture:", ledgerError);
        }

        return res.status(402).json({
          donationId: donation.id,
          status: "failed",
          error: "PayPal denied the payment capture",
        });
      }

      return res.status(502).json({
        error: "Unexpected PayPal capture status",
      });
    } catch (error) {
      console.error("Capture donation error:", error);

      return res.status(502).json({
        error: "Unable to capture PayPal donation",
      });
    }
  }
);

// ==========================================
// POST /donations/assistant
// Smart donation routing assistant
// ==========================================

router.post(
  "/assistant",
  requireAuth,
  requireRole("donor"),
  async (req, res) => {
    const { prompt, amountCents: explicitAmountCents } = req.body ?? {};

    if (!prompt && typeof explicitAmountCents !== "number") {
      return res.status(400).json({
        error: "Either prompt or amountCents is required",
      });
    }

    try {
      // 1. Fetch available causes to help parsing
      const orgs = await prisma.organization.findMany({
        select: { cause: true },
        distinct: ["cause"],
      });
      const knownCauses = orgs.map((o) => o.cause).filter(Boolean);

      let parsedRequest = null;
      let targetAmountCents =
        typeof explicitAmountCents === "number" && explicitAmountCents > 0
          ? explicitAmountCents
          : null;

      if (typeof prompt === "string" && prompt.trim().length > 0) {
        const parseRes = await parseDonationRequest(prompt, { knownCauses });
        if (parseRes.ok) {
          parsedRequest = parseRes.data;
          if (!targetAmountCents && parseRes.data.amountCents) {
            targetAmountCents = parseRes.data.amountCents;
          }
        }
      }

      if (!targetAmountCents || targetAmountCents <= 0) {
        return res.status(200).json({
          parsedRequest,
          routing: null,
          message: "Please specify a donation amount (e.g. $25 for education)",
        });
      }

      // 2. Fetch active campaigns with funding gaps
      const activeCampaigns = await prisma.campaign.findMany({
        where: {
          status: "active",
          currency: "USD",
        },
        include: {
          organization: true,
          donations: {
            where: {
              status: "completed",
            },
            select: {
              amountCents: true,
            },
          },
        },
      });

      const shortlist = activeCampaigns
        .map((c) => {
          const raisedCents = c.donations.reduce(
            (sum, d) => sum + d.amountCents,
            0
          );
          return {
            campaignId: c.id,
            title: c.title,
            organizationName: c.organization.name,
            cause: c.organization.cause,
            trustScore: c.organization.trustScore,
            goalCents: c.goalAmountCents,
            raisedCents,
          };
        })
        .filter((c) => c.goalCents > c.raisedCents);

      if (shortlist.length === 0) {
        return res.status(200).json({
          parsedRequest,
          routing: {
            allocations: [],
            leftoverCents: targetAmountCents,
            source: "trust_rank_fallback",
          },
          message: "No active campaigns currently have funding gaps",
        });
      }

      // 3. Route donation across shortlisted campaigns
      const routeRes = await routeDonation({
        amountCents: targetAmountCents,
        shortlist,
        request: typeof prompt === "string" ? prompt : undefined,
      });

      return res.status(200).json({
        parsedRequest,
        routing: routeRes.ok ? routeRes.data : null,
      });
    } catch (error) {
      console.error("Donation assistant error:", error);

      return res.status(500).json({
        error: "Failed to process donation assistance",
      });
    }
  }
);

export default router;