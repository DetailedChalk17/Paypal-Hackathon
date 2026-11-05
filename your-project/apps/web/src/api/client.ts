import type {
  Campaign as SharedCampaign,
  Donation as SharedDonation,
  Evidence as SharedEvidence,
  Milestone as SharedMilestone,
  Organization as SharedOrganization,
  Payout as SharedPayout,
  User as SharedUser,
  CreateCampaignInput,
  CreateMilestoneInput,
} from "@your-project/shared";

export type User = SharedUser;
export type Organization = SharedOrganization;
export type Milestone = SharedMilestone & { dueDate?: string | null };
export type Evidence = SharedEvidence;
export type Payout = SharedPayout;
export type Donation = SharedDonation;

export type Campaign = SharedCampaign & {
  organization: Organization;
  _count: { milestones: number; donations: number };
  raisedAmountCents?: number;
};

export type CampaignDetails = Omit<Campaign, "_count"> & {
  milestones: Milestone[];
  raisedAmountCents: number;
};

export type ReviewEvidence = Evidence & {
  previewUrl?: string;
  submittedAt?: string;
  milestone: Milestone & {
    campaign: CampaignDetails & { organization: Organization };
  };
};

export type FailedPayout = Payout & {
  milestone: Milestone & {
    campaign: CampaignDetails & {
      organization: Organization;
    };
  };
};

export type Receipt = {
  donation: Donation & { currency: string };
  donor: User;
  campaign: Pick<Campaign, "id" | "title" | "goalAmountCents">;
  organization: Organization;
  allocation: {
    [key: string]: unknown;
    allocations?: Array<{
      milestoneId?: string;
      title: string;
      budgetAmountCents?: number;
      allocatedAmountCents?: number;
      status: string;
      verificationStatus?: string;
      evidence?: Array<{ id: string; reviewerDecision: string; submittedAt: string }>;
      payouts?: Array<{ id: string; amountCents: number; status: string }>;
    }>;
    milestones?: Array<{
      milestoneId?: string;
      title: string;
      amountCents?: number;
      allocatedAmountCents?: number;
      status: string;
    }>;
  };
  ledger: { latestHash: string | null; createdAt: string | null };
};

export type Trace = {
  donationId: string;
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    status?: string;
    amountCents?: number;
    [key: string]: unknown;
  }>;
  links: Array<{
    id: string;
    source: string;
    target: string;
    label?: string;
    amountCents?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type LedgerVerification = {
  valid: boolean;
  checkedEvents: number;
  latestHash?: string | null;
  failedEventId?: string;
  reason?: string;
};

export type DashboardSummary = {
  donationsOverTime: Array<{ label: string; amountCents: number }>;
  spendByCause: Array<{ cause: string; amountCents: number }>;
  fundingGaps: Array<{ campaignId: string; title: string; gapAmountCents: number; cause?: string }>;
  trustScores: Array<{ organization: string; score: number; cause?: string }>;
  flags: Array<{ id: string; title: string; detail: string; severity: string; cause?: string }>;
  totals: {
    campaignCount: number;
    completedDonationCents: number;
    pendingEvidenceCount: number;
    paidPayoutCents: number;
  };
};

export type SuggestedSplit = {
  campaignId: string;
  title: string;
  organizationName: string;
  cause: string;
  amountCents: number;
  trustScore: number;
  reason: string;
};

export type DonationResult = {
  donationId: string;
  orderId?: string;
  approvalUrl?: string | null;
  status: string;
  amountCents?: number;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export function apiUrl(path: string) {
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

function notifyApiError(message: string) {
  window.dispatchEvent(new CustomEvent("impactledger:api-error", { detail: { message } }));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      credentials: "include",
      headers: {
        ...(init?.body && !isForm ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? `Unable to reach the service: ${error.message}` : "Unable to reach the service.";
    notifyApiError(message);
    throw new ApiError(message, 0);
  }
  const text = await response.text();
  let payload: unknown;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    const message = "The server returned an unreadable response.";
    notifyApiError(message);
    throw new ApiError(message, response.status);
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Request failed (${response.status}).`;
    notifyApiError(message);
    throw new ApiError(message, response.status);
  }

  return payload as T;
}

export const api = {
  getMe: () => request<{ user: User | null }>("/auth/me"),
  login: (role: User["role"]) =>
    request<{ user: User }>("/auth/demo-login", {
      method: "POST",
      body: JSON.stringify({ role }),
    }),
  logout: () =>
    request<{ message: string }>("/auth/logout", { method: "POST" }),
  getCampaigns: () => request<Campaign[]>("/campaigns"),
  getCampaign: (id: string) =>
    request<CampaignDetails>(`/campaigns/${encodeURIComponent(id)}`),
  createCampaign: (input: CreateCampaignInput) =>
    request<SharedCampaign>("/campaigns", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createMilestone: (campaignId: string, input: CreateMilestoneInput) =>
    request<Milestone>(
      `/campaigns/${encodeURIComponent(campaignId)}/milestones`,
      { method: "POST", body: JSON.stringify(input) },
    ),
  updatePayoutEmail: (organizationId: string, payoutEmail: string) =>
    request<{ id: string; payoutEmail: string }>(
      `/organizations/${encodeURIComponent(organizationId)}/payout-email`,
      { method: "PATCH", body: JSON.stringify({ payoutEmail }) },
    ),
  createDonation: (campaignId: string, amountCents: number) =>
    request<DonationResult>("/donations/create-order", {
      method: "POST",
      body: JSON.stringify({ campaignId, amountCents }),
    }),
  captureDonation: (id: string) =>
    request<DonationResult>(`/donations/${encodeURIComponent(id)}/capture`, {
      method: "POST",
    }),
  getReceipt: (id: string) =>
    request<Receipt>(`/donations/${encodeURIComponent(id)}/receipt`),
  getTrace: (id: string) =>
    request<Trace>(`/donations/${encodeURIComponent(id)}/trace`),
  verifyLedger: () => request<LedgerVerification>("/ledger/verify"),
  getReviewQueue: () => request<ReviewEvidence[]>("/evidence/review-queue"),
  approveEvidence: (id: string) =>
    request<{ message: string; payout: Payout }>(
      `/evidence/${encodeURIComponent(id)}/approve`,
      { method: "POST" },
    ),
  getFailedPayouts: () => request<FailedPayout[]>("/payouts/failed"),
  retryPayout: (id: string) =>
    request<{ message: string; payout: Payout; ledgerRecorded?: boolean }>(
      `/payouts/${encodeURIComponent(id)}/retry`,
      { method: "POST" },
    ),
  rejectEvidence: (id: string, reason: string) =>
    request<{ message: string }>(
      `/evidence/${encodeURIComponent(id)}/reject`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),
  uploadEvidence: (milestoneId: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<{ message: string; evidence: Evidence }>(
      `/milestones/${encodeURIComponent(milestoneId)}/evidence`,
      { method: "POST", body },
    );
  },
  getTrustScore: (organizationId: string) =>
    request<{
      organizationId: string;
      organizationName: string;
      trustScore: number;
      breakdown: unknown;
      updatedAt: string | null;
    }>(`/organizations/${encodeURIComponent(organizationId)}/trust-score`),
  recalculateTrustScore: (organizationId: string) =>
    request<{
      organizationId: string;
      organizationName: string;
      trustScore: number;
      breakdown: unknown;
      updatedAt: string | null;
    }>(`/organizations/${encodeURIComponent(organizationId)}/trust-score/recalculate`, { method: "POST" }),
  getDashboardSummary: (range: "month" | "quarter" | "half" = "half", cause = "All causes") => {
    const params = new URLSearchParams({ range });
    if (cause !== "All causes") params.set("cause", cause);
    return request<DashboardSummary>(`/dashboard/summary?${params.toString()}`);
  },
  getSuggestedSplit: (goal: string, amountCents: number) =>
    request<{ suggestions: SuggestedSplit[] }>("/routing/suggest", {
      method: "POST",
      body: JSON.stringify({ goal, amountCents }),
    }),
};
