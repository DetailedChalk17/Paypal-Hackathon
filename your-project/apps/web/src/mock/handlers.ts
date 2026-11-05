import { http, HttpResponse } from "msw";
import {
  campaignDetails,
  campaigns,
  demoDashboard,
  demoUsers,
  donations,
  failedPayouts,
  organizations,
  reviewEvidence,
  type MockDonation,
} from "./data";
import type { CampaignDetails, User } from "../api/client";

const noSession = () =>
  HttpResponse.json({ error: "Authentication required" }, { status: 401 });

function currentUser(): User | null {
  const role = localStorage.getItem("impactledger-demo-role") as User["role"] | null;
  return role ? demoUsers[role] ?? null : null;
}

function ensureRole(role: User["role"]) {
  const user = currentUser();
  return user?.role === role
    ? null
    : HttpResponse.json({ error: `Sign in as a ${role} to continue.` }, { status: 403 });
}

function donationById(id: string): MockDonation | undefined {
  return donations.find((donation) => donation.id === id);
}

function allocationFor(donation: MockDonation) {
  const campaign = campaignDetails.find((item) => item.id === donation.campaignId)!;
  const totalBudget = campaign.milestones.reduce((total, milestone) => total + milestone.budgetAmountCents, 0);
  let allocated = 0;
  const milestones = campaign.milestones.map((milestone, index) => {
    const amountCents =
      index === campaign.milestones.length - 1
        ? donation.amountCents - allocated
        : Math.floor((donation.amountCents * milestone.budgetAmountCents) / totalBudget);
    allocated += amountCents;
    return {
      milestoneId: milestone.id,
      title: milestone.title,
      amountCents,
      status: milestone.status,
    };
  });
  return {
    totalAmountCents: donation.amountCents,
    verifiedAmountCents: milestones
      .filter((milestone) => milestone.status === "approved" || milestone.status === "paid")
      .reduce((total, milestone) => total + milestone.amountCents, 0),
    pendingAmountCents: milestones
      .filter((milestone) => milestone.status !== "approved" && milestone.status !== "paid")
      .reduce((total, milestone) => total + milestone.amountCents, 0),
    milestones,
    allocations: milestones.map((milestone) => ({
      milestoneId: milestone.milestoneId!,
      title: milestone.title,
      budgetAmountCents: campaign.milestones.find((item) => item.id === milestone.milestoneId)!.budgetAmountCents,
      allocatedAmountCents: milestone.amountCents,
      status: milestone.status,
      verificationStatus: milestone.status === "approved" || milestone.status === "paid" ? "verified" : "pending",
      evidence: [],
      payouts: [],
    })),
  };
}

export const handlers = [
  http.get("/auth/me", () => {
    const user = currentUser();
    return user
      ? HttpResponse.json({ user })
      : noSession();
  }),
  http.post("/auth/demo-login", async ({ request }) => {
    const body = (await request.json()) as { role?: User["role"] };
    if (!body.role || !(body.role in demoUsers)) {
      return HttpResponse.json({ error: "Invalid login request" }, { status: 400 });
    }
    localStorage.setItem("impactledger-demo-role", body.role);
    return HttpResponse.json({ message: "Demo login successful", user: demoUsers[body.role] });
  }),
  http.post("/auth/logout", () => {
    localStorage.removeItem("impactledger-demo-role");
    return HttpResponse.json({ message: "Logged out successfully" });
  }),
  http.get("/campaigns", () => HttpResponse.json(campaigns)),
  http.get("/campaigns/:id", ({ params }) => {
    const campaign = campaignDetails.find((item) => item.id === params.id);
    return campaign
      ? HttpResponse.json(campaign)
      : HttpResponse.json({ error: "Campaign not found" }, { status: 404 });
  }),
  http.post("/campaigns", async ({ request }) => {
    const denied = ensureRole("organizer");
    if (denied) return denied;
    const body = (await request.json()) as {
      organizationId: string;
      title: string;
      goalAmountCents: number;
    };
    const organization = organizations.find((item) => item.id === body.organizationId);
    if (!organization) return HttpResponse.json({ error: "Organization not found" }, { status: 404 });
    const id = crypto.randomUUID();
    const campaign = {
      id,
      organizationId: organization.id,
      organizerId: demoUsers.organizer.id,
      title: body.title,
      goalAmountCents: body.goalAmountCents,
      currency: "USD" as const,
      status: "active" as const,
      organization,
      _count: { milestones: 0, donations: 0 },
    };
    campaigns.unshift(campaign);
    const detail: CampaignDetails = { ...campaign, milestones: [], raisedAmountCents: 0 };
    campaignDetails.unshift(detail);
    return HttpResponse.json(campaign, { status: 201 });
  }),
  http.post("/campaigns/:id/milestones", async ({ params, request }) => {
    const denied = ensureRole("organizer");
    if (denied) return denied;
    const campaign = campaignDetails.find((item) => item.id === params.id);
    if (!campaign) return HttpResponse.json({ error: "Campaign not found" }, { status: 404 });
    const body = (await request.json()) as { title: string; budgetAmountCents: number; dueDate?: string };
    const allocated = campaign.milestones.reduce((total, milestone) => total + milestone.budgetAmountCents, 0);
    if (allocated + body.budgetAmountCents > campaign.goalAmountCents) {
      return HttpResponse.json({ error: "Total milestone budget cannot exceed campaign goal" }, { status: 400 });
    }
    const milestone = {
      id: crypto.randomUUID(),
      campaignId: campaign.id,
      title: body.title,
      budgetAmountCents: body.budgetAmountCents,
      status: "open" as const,
      dueDate: body.dueDate ?? null,
    };
    campaign.milestones.push(milestone);
    const listItem = campaigns.find((item) => item.id === campaign.id);
    if (listItem) listItem._count.milestones += 1;
    return HttpResponse.json(milestone, { status: 201 });
  }),
  http.post("/donations/create-order", async ({ request }) => {
    const denied = ensureRole("donor");
    if (denied) return denied;
    const body = (await request.json()) as { campaignId: string; amountCents: number };
    const campaign = campaignDetails.find((item) => item.id === body.campaignId);
    if (!campaign) return HttpResponse.json({ error: "Campaign not found" }, { status: 404 });
    if (campaign.status !== "active") {
      return HttpResponse.json({ error: "This campaign is not accepting donations" }, { status: 409 });
    }
    if (!Number.isSafeInteger(body.amountCents) || body.amountCents <= 0) {
      return HttpResponse.json({ error: "Donation amount must be a positive number of cents" }, { status: 400 });
    }
    const donation: MockDonation = {
      id: crypto.randomUUID(),
      campaignId: campaign.id,
      donorId: demoUsers.donor.id,
      amountCents: body.amountCents,
      status: "completed",
      paypalOrderId: `MOCK-${crypto.randomUUID()}`,
      paypalCaptureId: `CAP-${crypto.randomUUID()}`,
    };
    donations.push(donation);
    campaign.raisedAmountCents += donation.amountCents;
    const listItem = campaigns.find((item) => item.id === campaign.id);
    if (listItem) listItem._count.donations += 1;
    if (listItem) listItem.raisedAmountCents = campaign.raisedAmountCents;
    return HttpResponse.json({
      donationId: donation.id,
      orderId: donation.paypalOrderId,
      status: donation.status,
      amountCents: donation.amountCents,
    }, { status: 201 });
  }),
  http.post("/donations/:id/capture", ({ params }) => {
    const donation = donationById(String(params.id));
    return donation
      ? HttpResponse.json({ donationId: donation.id, status: "completed", amountCents: donation.amountCents })
      : HttpResponse.json({ error: "Donation not found" }, { status: 404 });
  }),
  http.get("/donations/:id/receipt", ({ params }) => {
    const donation = donationById(String(params.id));
    if (!donation) return HttpResponse.json({ error: "Donation not found" }, { status: 404 });
    const campaign = campaignDetails.find((item) => item.id === donation.campaignId)!;
    return HttpResponse.json({
      donation: {
        id: donation.id,
        campaignId: campaign.id,
        donorId: donation.donorId,
        amountCents: donation.amountCents,
        paypalOrderId: donation.paypalOrderId,
        paypalCaptureId: donation.paypalCaptureId,
        status: donation.status,
        currency: campaign.currency,
      },
      donor: demoUsers.donor,
      campaign: { id: campaign.id, title: campaign.title, goalAmountCents: campaign.goalAmountCents },
      organization: campaign.organization,
      allocation: allocationFor(donation),
      ledger: { latestHash: "demo-ledger-hash-" + donation.id.slice(0, 8), createdAt: new Date().toISOString() },
    });
  }),
  http.get("/donations/:id/trace", ({ params }) => {
    const donation = donationById(String(params.id));
    if (!donation) return HttpResponse.json({ error: "Donation not found" }, { status: 404 });
    const campaign = campaignDetails.find((item) => item.id === donation.campaignId)!;
    const allocation = allocationFor(donation);
    const nodes = [
      { id: `donor:${donation.donorId}`, type: "donor", label: demoUsers.donor.name },
      { id: `donation:${donation.id}`, type: "donation", label: "Donation", amountCents: donation.amountCents, status: donation.status },
      { id: `campaign:${campaign.id}`, type: "campaign", label: campaign.title },
      { id: `organization:${campaign.organization.id}`, type: "organization", label: campaign.organization.name },
      ...allocation.milestones.map((milestone) => ({
        id: `milestone:${milestone.milestoneId}`,
        type: "milestone",
        label: milestone.title,
        amountCents: milestone.amountCents,
        status: milestone.status,
      })),
    ];
    const links = [
      { id: "donor-to-donation", source: `donor:${donation.donorId}`, target: `donation:${donation.id}` },
      { id: "donation-to-campaign", source: `donation:${donation.id}`, target: `campaign:${campaign.id}` },
      { id: "campaign-to-organization", source: `campaign:${campaign.id}`, target: `organization:${campaign.organization.id}` },
      ...allocation.milestones.map((milestone) => ({
        id: `campaign-to-${milestone.milestoneId}`,
        source: `campaign:${campaign.id}`,
        target: `milestone:${milestone.milestoneId}`,
        amountCents: milestone.amountCents,
      })),
    ];
    return HttpResponse.json({ donationId: donation.id, nodes, links, allocation, ledgerEvents: [] });
  }),
  http.get("/ledger/verify", () =>
    HttpResponse.json({ valid: true, checkedEvents: donations.length * 2, latestHash: "demo-ledger-hash" }),
  ),
  http.get("/evidence/review-queue", () => {
    const denied = ensureRole("reviewer");
    return denied ?? HttpResponse.json(reviewEvidence);
  }),
  http.get("/evidence-files/:id", ({ params }) => {
    if (!reviewEvidence.some((item) => item.id === params.id)) {
      return HttpResponse.json({ error: "Evidence not found" }, { status: 404 });
    }
    return HttpResponse.redirect("/evidence-preview.svg");
  }),
  http.post("/evidence/:id/approve", ({ params }) => {
    const denied = ensureRole("reviewer");
    if (denied) return denied;
    const evidence = reviewEvidence.find((item) => item.id === params.id);
    if (!evidence) return HttpResponse.json({ error: "Evidence not found" }, { status: 404 });
    evidence.reviewerDecision = "approved";
    evidence.milestone.status = "paid";
    return HttpResponse.json({
      message: "Evidence approved and payout completed",
      payout: {
        id: crypto.randomUUID(),
        milestoneId: evidence.milestoneId,
        amountCents: evidence.milestone.budgetAmountCents,
        senderBatchId: `MOCK-PAYOUT-${Date.now()}`,
        paypalBatchId: null,
        status: "paid",
      },
    });
  }),
  http.post("/evidence/:id/reject", async ({ params, request }) => {
    const denied = ensureRole("reviewer");
    if (denied) return denied;
    const evidence = reviewEvidence.find((item) => item.id === params.id);
    if (!evidence) return HttpResponse.json({ error: "Evidence not found" }, { status: 404 });
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    evidence.reviewerDecision = "rejected";
    evidence.aiFindings.reviewerReason = body.reason ?? "";
    evidence.milestone.status = "rejected";
    return HttpResponse.json({ message: "Evidence rejected" });
  }),
  http.get("/payouts/failed", () => {
    const denied = ensureRole("reviewer");
    return denied ?? HttpResponse.json(failedPayouts);
  }),
  http.post("/payouts/:id/retry", ({ params }) => {
    const denied = ensureRole("reviewer");
    if (denied) return denied;
    const payout = failedPayouts.find((item) => item.id === params.id);
    if (!payout) return HttpResponse.json({ error: "Failed payout not found" }, { status: 404 });
    payout.status = "paid";
    payout.senderBatchId = `MOCK-RETRY-${Date.now()}`;
    return HttpResponse.json({ message: "Payout retry completed", payout, ledgerRecorded: true });
  }),
  http.post("/milestones/:id/evidence", async ({ params, request }) => {
    const denied = ensureRole("organizer");
    if (denied) return denied;
    const milestone = campaignDetails.flatMap((item) => item.milestones).find((item) => item.id === params.id);
    if (!milestone) return HttpResponse.json({ error: "Milestone not found" }, { status: 404 });
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return HttpResponse.json({ error: "A file is required" }, { status: 400 });
    milestone.status = "evidence_submitted";
    const campaign = campaignDetails.find((item) => item.id === milestone.campaignId)!;
    const evidence = {
      id: crypto.randomUUID(),
      milestoneId: milestone.id,
      file: file.name,
      extractedFields: { vendor: "Example supplier", total: 1850, currency: "USD", date: new Date().toISOString().slice(0, 10) },
      aiFindings: { flags: ["Receipt details extracted"], summary: "Document received and queued for reviewer approval." },
      reviewerDecision: "pending" as const,
      submittedAt: new Date().toISOString(),
    };
    reviewEvidence.unshift({
      ...evidence,
      milestone: { ...milestone, campaign: { ...campaign, organization: campaign.organization } },
    });
    return HttpResponse.json({ message: "Evidence submitted", evidence }, { status: 201 });
  }),
  http.get("/organizations/:id/trust-score", ({ params }) => {
    const organization = organizations.find((item) => item.id === params.id);
    return organization
      ? HttpResponse.json({ organizationId: organization.id, organizationName: organization.name, trustScore: organization.trustScore, breakdown: null, updatedAt: null })
      : HttpResponse.json({ error: "Organization not found" }, { status: 404 });
  }),
  http.patch("/organizations/:id/payout-email", async ({ params, request }) => {
    const denied = ensureRole("organizer");
    if (denied) return denied;
    const organization = organizations.find((item) => item.id === params.id);
    if (!organization) return HttpResponse.json({ error: "Organization not found" }, { status: 404 });
    const body = (await request.json()) as { payoutEmail?: string };
    if (!body.payoutEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.payoutEmail)) {
      return HttpResponse.json({ error: "Enter a valid payout email address." }, { status: 400 });
    }
    organization.payoutEmail = body.payoutEmail;
    return HttpResponse.json({ id: organization.id, payoutEmail: organization.payoutEmail });
  }),
  http.post("/organizations/:id/trust-score/recalculate", ({ params }) => {
    const denied = ensureRole("reviewer");
    if (denied) return denied;
    const organization = organizations.find((item) => item.id === params.id);
    return organization
      ? HttpResponse.json({ organizationId: organization.id, organizationName: organization.name, trustScore: organization.trustScore, breakdown: null, updatedAt: new Date().toISOString() })
      : HttpResponse.json({ error: "Organization not found" }, { status: 404 });
  }),
  http.get("/dashboard/summary", ({ request }) => {
    const url = new URL(request.url);
    const range = url.searchParams.get("range");
    const cause = url.searchParams.get("cause");
    const monthCount = range === "month" ? 1 : range === "quarter" ? 3 : 6;
    const filteredCampaigns = campaigns.filter((campaign) => !cause || campaign.organization.cause === cause);
    const filteredFlags = demoDashboard.flags.filter((item) => !cause || item.cause === cause);
    const allRaisedCents = campaigns.reduce((sum, campaign) => sum + (campaign.raisedAmountCents ?? 0), 0);
    const filteredRaisedCents = filteredCampaigns.reduce((sum, campaign) => sum + (campaign.raisedAmountCents ?? 0), 0);
    const causeShare = allRaisedCents ? filteredRaisedCents / allRaisedCents : 0;
    return HttpResponse.json({
      ...demoDashboard,
      donationsOverTime: demoDashboard.donationsOverTime.slice(-monthCount).map((item) => ({
        ...item,
        amountCents: cause ? Math.round(item.amountCents * causeShare) : item.amountCents,
      })),
      spendByCause: demoDashboard.spendByCause.filter((item) => !cause || item.cause === cause),
      fundingGaps: demoDashboard.fundingGaps.filter((item) => !cause || item.cause === cause),
      trustScores: demoDashboard.trustScores.filter((item) => !cause || item.cause === cause),
      flags: filteredFlags,
      totals: {
        ...demoDashboard.totals,
        campaignCount: filteredCampaigns.length,
        completedDonationCents: filteredRaisedCents,
        pendingEvidenceCount: filteredFlags.length,
        paidPayoutCents: cause ? Math.round(demoDashboard.totals.paidPayoutCents * causeShare) : demoDashboard.totals.paidPayoutCents,
      },
    });
  }),
  http.post("/routing/suggest", async ({ request }) => {
    const body = (await request.json()) as { goal?: string; amountCents?: number };
    const goal = (body.goal ?? "").toLowerCase();
    const available = campaignDetails
      .filter((campaign) => campaign.status === "active")
      .sort((a, b) => {
        const ranking = (campaign: typeof a) => {
          const gapPercent = Math.max(0, campaign.goalAmountCents - campaign.raisedAmountCents) / campaign.goalAmountCents * 100;
          const matchesGoal = goal.includes(campaign.organization.cause.toLowerCase());
          return campaign.organization.trustScore * 0.6 + gapPercent * 0.25 + (matchesGoal ? 15 : 0);
        };
        return ranking(b) - ranking(a);
      })
      .slice(0, 3);
    const remaining = Math.max(0, Math.floor(body.amountCents ?? 0));
    const baseAmount = Math.floor(remaining / Math.max(available.length, 1));
    let allocated = 0;
    const suggestions = available.map((campaign, index) => {
      const amountCents = index === available.length - 1 ? remaining - allocated : baseAmount;
      allocated += amountCents;
      return {
        campaignId: campaign.id,
        title: campaign.title,
        organizationName: campaign.organization.name,
        cause: campaign.organization.cause,
        amountCents,
        trustScore: campaign.organization.trustScore,
        reason: `${campaign.organization.name} has a trust score of ${campaign.organization.trustScore}, a meaningful funding gap${goal.includes(campaign.organization.cause.toLowerCase()) ? ", and matches your stated goal" : ""}.`,
      };
    });
    return HttpResponse.json({ suggestions });
  }),
];
