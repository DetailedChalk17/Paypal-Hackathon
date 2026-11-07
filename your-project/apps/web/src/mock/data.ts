import type { Campaign, CampaignDetails, DashboardSummary, FailedPayout, Organization, ReviewEvidence, User } from "../api/client";

export const demoUsers: Record<User["role"], User> = {
  donor: {
    id: "10000000-0000-4000-8000-000000000001",
    name: "Demo Donor",
    email: "donor@example.com",
    role: "donor",
  },
  organizer: {
    id: "10000000-0000-4000-8000-000000000002",
    name: "Demo Organizer",
    email: "organizer@example.com",
    role: "organizer",
  },
  reviewer: {
    id: "10000000-0000-4000-8000-000000000003",
    name: "Demo Reviewer",
    email: "reviewer@example.com",
    role: "reviewer",
  },
};

export const organizations: Organization[] = [
  { id: "20000000-0000-4000-8000-000000000001", name: "Green Earth Collective", cause: "Environment", location: "Bengaluru", payoutEmail: "payments@greenearth.example", verified: true, trustScore: 88 },
  { id: "20000000-0000-4000-8000-000000000002", name: "Bright Futures Foundation", cause: "Education", location: "Mysuru", payoutEmail: "payments@brightfutures.example", verified: true, trustScore: 94 },
  { id: "20000000-0000-4000-8000-000000000003", name: "Community Health Bridge", cause: "Healthcare", location: "Bengaluru", payoutEmail: "payments@healthbridge.example", verified: true, trustScore: 82 },
  { id: "20000000-0000-4000-8000-000000000004", name: "Safe Water Initiative", cause: "Water and Sanitation", location: "Hubballi", payoutEmail: "payments@safewater.example", verified: true, trustScore: 76 },
  { id: "20000000-0000-4000-8000-000000000005", name: "Women Forward Network", cause: "Women Empowerment", location: "Mangaluru", payoutEmail: "payments@womenforward.example", verified: true, trustScore: 91 },
  { id: "20000000-0000-4000-8000-000000000006", name: "Rural Skills Foundation", cause: "Livelihoods", location: "Tumakuru", payoutEmail: "payments@ruralskills.example", verified: false, trustScore: 73 },
  { id: "20000000-0000-4000-8000-000000000007", name: "Animal Care Alliance", cause: "Animal Welfare", location: "Bengaluru", payoutEmail: "payments@animalcare.example", verified: true, trustScore: 42 },
  { id: "20000000-0000-4000-8000-000000000008", name: "Food for Every Family", cause: "Hunger Relief", location: "Shivamogga", payoutEmail: "payments@foodfamily.example", verified: true, trustScore: 85 },
];

const campaignSeed = [
  ["Urban Tree Restoration", 2500000, 0],
  ["Digital Classrooms for Rural Schools", 3000000, 1],
  ["Mobile Healthcare Clinics", 4000000, 2],
  ["Clean Drinking Water for Villages", 2000000, 3],
  ["Women Entrepreneurship Program", 1800000, 4],
  ["Rural Digital Skills Training", 1500000, 5],
  ["Veterinary Outreach Program", 1200000, 6],
  ["Nutrition Support for Families", 2200000, 7],
] as const;

const raisedSeed = [840000, 1750000, 920000, 565000, 702000, 280000, 350000, 1180000];

export const campaigns: Campaign[] = campaignSeed.map(([title, goalAmountCents, organizationIndex], index) => ({
  id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  organizationId: organizations[organizationIndex].id,
  organizerId: demoUsers.organizer.id,
  title,
  goalAmountCents,
  currency: "USD",
  status: "active",
  organization: organizations[organizationIndex],
  _count: { milestones: 2, donations: index % 4 },
  raisedAmountCents: raisedSeed[index],
}));

export const campaignDetails: CampaignDetails[] = campaigns.map((campaign, index) => ({
  ...campaign,
  raisedAmountCents: raisedSeed[index],
  milestones: [
    { id: `40000000-0000-4000-8000-${String(index * 2 + 1).padStart(12, "0")}`, campaignId: campaign.id, title: "Planning and Procurement", budgetAmountCents: Math.floor(campaign.goalAmountCents * 0.4), status: "approved", dueDate: "2026-12-01T00:00:00.000Z" },
    { id: `40000000-0000-4000-8000-${String(index * 2 + 2).padStart(12, "0")}`, campaignId: campaign.id, title: "Implementation and Delivery", budgetAmountCents: campaign.goalAmountCents - Math.floor(campaign.goalAmountCents * 0.4), status: index === 6 ? "evidence_submitted" : "open", dueDate: "2027-01-15T00:00:00.000Z" },
  ],
}));

export const demoDashboard: DashboardSummary = {
  donationsOverTime: [
    { label: "Jun", amountCents: 160000 },
    { label: "Jul", amountCents: 240000 },
    { label: "Aug", amountCents: 190000 },
    { label: "Sep", amountCents: 390000 },
    { label: "Oct", amountCents: 320000 },
    { label: "Nov", amountCents: 460000 },
  ],
  spendByCause: campaigns.map((campaign) => ({
    cause: campaign.organization.cause,
    amountCents: campaign.raisedAmountCents ?? 0,
  })),
  fundingGaps: campaigns.slice(0, 5).map((campaign, index) => ({
    campaignId: campaign.id,
    title: campaign.title,
    gapAmountCents: campaign.goalAmountCents - campaignDetails[index].raisedAmountCents,
    cause: campaign.organization.cause,
  })),
  trustScores: organizations.map(({ name, trustScore, cause }) => ({ organization: name, score: trustScore, cause })),
  flags: [
    { id: "flag-1", title: "Evidence needs review", detail: "Veterinary Outreach · Implementation and Delivery", severity: "medium", cause: "Animal Welfare" },
    { id: "flag-2", title: "Organization verification pending", detail: "Rural Skills Foundation", severity: "low", cause: "Livelihoods" },
  ],
  totals: {
    campaignCount: campaigns.length,
    completedDonationCents: 1875000,
    pendingEvidenceCount: 1,
    paidPayoutCents: 610000,
  },
};

export type MockDonation = {
  id: string;
  campaignId: string;
  donorId: string;
  amountCents: number;
  status: "completed";
  paypalOrderId: string;
  paypalCaptureId: string;
};

export const donations: MockDonation[] = [];

export const failedPayouts: FailedPayout[] = [
  {
    id: "60000000-0000-4000-8000-000000000001",
    milestoneId: campaignDetails[6].milestones[1].id,
    amountCents: 185000,
    senderBatchId: null as string | null,
    paypalBatchId: null,
    status: "failed" as const,
    milestone: {
      ...campaignDetails[6].milestones[1],
      campaign: { ...campaignDetails[6], organization: organizations[6] },
    },
  },
];

export const reviewEvidence: ReviewEvidence[] = [
  {
    id: "50000000-0000-4000-8000-000000000001",
    milestoneId: campaignDetails[6].milestones[1].id,
    file: "veterinary-outreach-receipt.jpg",
    extractedFields: { vendor: "Bengaluru Animal Care Supplies", total: 1850, currency: "USD", date: "2026-10-28" },
    aiFindings: { flags: ["Receipt amount is within milestone budget"], summary: "Vendor, date, and total were extracted successfully." },
    reviewerDecision: "pending",
    submittedAt: "2026-11-02T10:30:00.000Z",
    milestone: {
      ...campaignDetails[6].milestones[1],
      campaign: { ...campaignDetails[6], organization: organizations[6] },
    },
  },
];
