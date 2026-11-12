import { Router } from "express";

import {
  requireAuth,
  requireRole,
} from "../middleware/auth.middleware";

import {
  reserveRefundRequest,
  updateRefundFromPayPalResponse,
} from "../services/refund.service";

import { prisma } from "../lib/prisma";
import { appendEvent, appendEventInTransaction } from "../services/ledger.service";
import { parseDonationRequest, routeDonation } from "../services/ai.service";

const router = Router();

function isValidUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

// ==========================================
// POST /donations/order
//
// Create a new donation record and initiate
// a PayPal order.
// ==========================================

router.post(
  ["/order", "/create-order"],
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
      typeof amountCents !== "number" ||
      !Number.isInteger(amountCents) ||
      amountCents <= 0
    ) {
      return res.status(400).json({
        error: "amountCents must be a positive integer",
      });
    }

    try {
      const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: {
          id: true,
          status: true,
          currency: true,
          goalAmountCents: true,
        },
      });

      if (!campaign) {
        return res.status(404).json({
          error: "Campaign not found",
        });
      }

      if (campaign.status !== "active") {
        return res.status(400).json({
          error: "Campaign is not active",
        });
      }

      // Check whether goal amount has been met
      const aggregate = await prisma.donation.aggregate({
        where: {
          campaignId,
          status: "completed",
        },
        _sum: {
          amountCents: true,
        },
      });

      const currentTotalCents = aggregate._sum.amountCents ?? 0;

      if (currentTotalCents >= campaign.goalAmountCents) {
        return res.status(400).json({
          error: "Campaign goal has already been reached",
        });
      }

      // Create initial pending donation record
      const donation = await prisma.donation.create({
        data: {
          campaignId,
          donorId: req.user!.id,
          amountCents,
          status: "pending",
        },
      });

      // Initiate PayPal order creation
      let paypalOrder;

      try {
        const { createOrder } =
          await import("@your-project/paypal");

        const frontendUrl =
          process.env.FRONTEND_URL ?? "http://localhost:5173";

        paypalOrder = await createOrder({
          campaignId,
          amountCents,
          requestId: donation.id,
          returnUrl: `${frontendUrl}/donations/return?donationId=${donation.id}`,
          cancelUrl: `${frontendUrl}/donations/cancel?donationId=${donation.id}`,
        });
      } catch (paypalError) {
        console.error("PayPal order creation error:", paypalError);

        await prisma.donation.update({
          where: { id: donation.id },
          data: { status: "failed" },
        });

        await appendEvent(
          "DONATION_ORDER_FAILED",
          donation.id,
          {
            donationId: donation.id,
            campaignId,
            amountCents,
            error: (paypalError as any)?.message ?? "PayPal order creation failed",
          }
        );

        return res.status(502).json({
          error: "Unable to create PayPal donation order",
        });
      }

      // Update donation record with PayPal order information
      await prisma.donation.update({
        where: { id: donation.id },
        data: {
          paypalOrderId: paypalOrder.orderId,
        },
      });

      await appendEvent(
        "DONATION_ORDER_CREATED",
        donation.id,
        {
          donationId: donation.id,
          campaignId,
          amountCents,
          paypalOrderId: paypalOrder.orderId,
        }
      );

      return res.status(201).json({
        donationId: donation.id,
        orderId: paypalOrder.orderId,
        approvalUrl: paypalOrder.approvalUrl,
        status: "pending",
        ledgerRecorded: true,
      });
    } catch (error) {
      console.error("Create donation error:", error);

      return res.status(500).json({
        error: "Failed to create donation",
      });
    }
  }
);

// ==========================================
// POST /donations/capture
//
// Capture payment after donor approves the order.
// ==========================================

router.post(
  ["/capture", "/:donationId/capture"],
  requireAuth,
  requireRole("donor"),
  async (req, res) => {
    const donationId = req.params.donationId ?? req.body?.donationId;

    if (!isValidUuid(donationId)) {
      return res.status(400).json({
        error: "Invalid donation ID",
      });
    }

    try {
      const donation = await prisma.donation.findUnique({
        where: { id: donationId },
      });

      if (!donation) {
        return res.status(404).json({
          error: "Donation not found",
        });
      }

      if (donation.donorId !== req.user!.id) {
        return res.status(403).json({
          error: "You cannot capture this donation",
        });
      }

      // Idempotency: return existing completion state
      if (donation.status === "completed") {
        return res.status(200).json({
          donationId: donation.id,
          status: "completed",
          message: "Donation already captured",
          alreadyCaptured: true,
        });
      }

      if (donation.status !== "pending") {
        return res.status(400).json({
          error: `Donation cannot be captured in '${donation.status}' status`,
        });
      }

      if (!donation.paypalOrderId) {
        return res.status(400).json({
          error: "Donation does not have an associated PayPal order",
        });
      }

      // Capture PayPal order
      let captureResult;

      try {
        const { captureOrder } =
          await import("@your-project/paypal");

        captureResult = await captureOrder({
          orderId: donation.paypalOrderId,
          expectedAmountCents: donation.amountCents,
          requestId: donation.id,
        });
      } catch (paypalError) {
        console.error("PayPal order capture error:", paypalError);

        return res.status(502).json({
          error: "Unable to capture PayPal payment",
        });
      }

      // Handle non-completed statuses (e.g. PENDING, DENIED)
      if (captureResult.captureStatus === "PENDING") {
        await prisma.donation.update({
          where: { id: donation.id },
          data: {
            paypalCaptureId: captureResult.captureId,
          },
        });

        return res.status(202).json({
          donationId: donation.id,
          status: "pending",
          captureId: captureResult.captureId,
        });
      }

      if (captureResult.captureStatus !== "COMPLETED") {
        // Check current DB status first to prevent race downgrade
        const latest = await prisma.donation.findUnique({
          where: { id: donation.id },
        });

        if (latest?.status === "completed") {
          return res.status(200).json({
            donationId: latest.id,
            status: "completed",
            captureId: latest.paypalCaptureId ?? captureResult.captureId,
          });
        }

        await prisma.donation.update({
          where: { id: donation.id },
          data: {
            status: "failed",
            paypalCaptureId: captureResult.captureId,
          },
        });

        await appendEvent(
          "DONATION_CAPTURE_DENIED",
          donation.id,
          {
            donationId: donation.id,
            campaignId: donation.campaignId,
            donorId: donation.donorId,
            paypalOrderId: donation.paypalOrderId,
            paypalCaptureId: captureResult.captureId,
            status: captureResult.captureStatus,
          }
        );

        return res.status(402).json({
          donationId: donation.id,
          status: "failed",
          captureId: captureResult.captureId,
        });
      }

      // Update donation status and record in ledger atomically
      const updatedDonation = await prisma.$transaction(
        async (tx) => {
          // Re-check donation status inside transaction
          const current = await tx.donation.findUnique({
            where: { id: donation.id },
          });

          if (current?.status === "completed" || current?.status === "refunded") {
            return current;
          }

          const captured = await tx.donation.update({
            where: { id: donation.id },
            data: {
              status: "completed",
              completedAt: new Date(),
              paypalCaptureId: captureResult.captureId,
            },
          });

          await appendEventInTransaction(
            tx,
            "DONATION_COMPLETED",
            donation.id,
            {
              amountCents: donation.amountCents,
              campaignId: donation.campaignId,
              donorId: donation.donorId,
              paypalOrderId: donation.paypalOrderId,
              paypalCaptureId: captureResult.captureId,
            }
          );

          return captured;
        }
      );

      // If the donation was already refunded during the capture wait, return its refunded state
      if (updatedDonation.status === "refunded") {
        return res.status(200).json({
          donationId: updatedDonation.id,
          status: "refunded",
          captureId: captureResult.captureId,
        });
      }

      // Check whether campaign has met its funding goal
      const campaign = await prisma.campaign.findUnique({
        where: { id: donation.campaignId },
        select: {
          id: true,
          goalAmountCents: true,
          status: true,
        },
      });

      if (campaign && campaign.status === "active") {
        const aggregate = await prisma.donation.aggregate({
          where: {
            campaignId: campaign.id,
            status: "completed",
          },
          _sum: {
            amountCents: true,
          },
        });

        const totalRaisedCents = aggregate._sum.amountCents ?? 0;

        if (totalRaisedCents >= campaign.goalAmountCents) {
          await prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: "completed" },
          });
        }
      }

      return res.status(200).json({
        donationId: updatedDonation.id,
        status: updatedDonation.status,
        captureId: updatedDonation.paypalCaptureId,
        ledgerRecorded: true,
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

// ==========================================
// POST /donations/:donationId/refunds
//
// Initiate a full or partial PayPal refund.
// Reviewer-only operation.
// ==========================================

router.post(
  "/:donationId/refunds",
  requireAuth,
  requireRole("reviewer"),
  async (req, res) => {
    const donationId = req.params.donationId;

    if (!isValidUuid(donationId)) {
      return res.status(400).json({
        error: "Invalid donation ID",
      });
    }

    const idempotencyKey = req.get("Idempotency-Key");

    if (!idempotencyKey?.trim()) {
      return res.status(400).json({
        error: "Idempotency-Key header is required",
      });
    }

    const body = req.body;

    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body)
    ) {
      return res.status(400).json({
        error: "A JSON request body is required",
      });
    }

    const amountCents = body.amountCents;
    const noteToPayer = body.noteToPayer;

    if (
      amountCents !== undefined &&
      typeof amountCents !== "number"
    ) {
      return res.status(400).json({
        error: "amountCents must be a number",
      });
    }

    if (
      noteToPayer !== undefined &&
      typeof noteToPayer !== "string"
    ) {
      return res.status(400).json({
        error: "noteToPayer must be a string",
      });
    }

    try {
      // 1. Reserve the refund before calling PayPal.
      const reservation = await reserveRefundRequest({
        donationId,
        idempotencyKey,
        amountCents,
        noteToPayer,
      });

      if (!reservation.ok) {
        return res.status(reservation.statusCode).json({
          error: reservation.error,
        });
      }

      const refund = reservation.refund;

      // 2. Repeated requests return the existing record.
      // Never initiate another PayPal call for a duplicate key.
      if (reservation.duplicate) {
        const awaitingResolution = [
          "processing",
          "pending",
          "reconciliation_required",
        ].includes(refund.status);

        return res.status(
          awaitingResolution ? 202 : 200
        ).json({
          message: "Existing refund request returned",
          duplicate: true,
          refund: {
            id: refund.id,
            paypalRefundId: refund.paypalRefundId,
            amountCents: refund.amountCents,
            status: refund.status,
            completedAt: refund.completedAt,
          },
        });
      }

      // 3. Send the refund request using the stable Refund UUID.
      let paypalResult;

      try {
        const { refundCapture } =
          await import("@your-project/paypal");

        paypalResult = await refundCapture({
          captureId: reservation.captureId,
          requestId: refund.id,
          customId: refund.id,
          amountCents: refund.amountCents,
          ...(refund.noteToPayer
            ? { noteToPayer: refund.noteToPayer }
            : {}),
        });
      } catch (paypalError) {
        console.error(
          "PayPal refund request outcome is uncertain:",
          paypalError
        );

        // A timeout or provider error does not prove
        // that the refund was not processed.
        try {
          const updated =
            await updateRefundFromPayPalResponse(
              refund.id,
              { status: "UNKNOWN" },
              paypalError instanceof Error
                ? paypalError.message
                : "Unknown PayPal error"
            );

          return res.status(202).json({
            message:
              "Refund outcome is uncertain and requires reconciliation",
            refund: {
              id: updated.id,
              amountCents: updated.amountCents,
              status: updated.status,
            },
          });
        } catch (persistenceError) {
          console.error(
            "Failed to persist uncertain refund outcome:",
            persistenceError
          );

          return res.status(202).json({
            message:
              "Refund outcome is uncertain. The existing reservation must be reconciled.",
            refundId: refund.id,
            status: refund.status,
          });
        }
      }

      // 4. Persist PayPal's response.
      let updated;

      try {
        updated = await updateRefundFromPayPalResponse(
          refund.id,
          paypalResult
        );
      } catch (persistenceError) {
        console.error(
          "Failed to persist PayPal refund response:",
          persistenceError
        );

        return res.status(202).json({
          message:
            "PayPal returned a response, but local reconciliation is pending",
          refundId: refund.id,
          status: "processing",
        });
      }

      // 5. Return the provider-confirmed state.
      const awaitingResolution = [
        "processing",
        "pending",
        "reconciliation_required",
      ].includes(updated.status);

      return res.status(
        awaitingResolution ? 202 : 200
      ).json({
        message: "Refund request processed",
        refund: {
          id: updated.id,
          paypalRefundId: updated.paypalRefundId,
          amountCents: updated.amountCents,
          status: updated.status,
          completedAt: updated.completedAt,
        },
      });
    } catch (error) {
      console.error("Create refund error:", error);

      return res.status(500).json({
        error: "Unable to create refund request",
      });
    }
  }
);

export default router;
