import { useCallback, useEffect, useMemo, useState } from "react";

type Role = "donor" | "organizer" | "reviewer";

type User = {
  id: string;
  name: string;
  email: string;
  role: Role;
};

type Organization = {
  id: string;
  name: string;
  cause: string;
  location: string;
  verified: boolean;
  trustScore: number;
};

type Campaign = {
  id: string;
  title: string;
  goalAmountCents: number;
  currency: string;
  status: "draft" | "active" | "completed" | "cancelled";
  organization: Organization;
  _count: {
    milestones: number;
    donations: number;
  };
};

type Milestone = {
  id: string;
  title: string;
  budgetAmountCents: number;
  status: "open" | "evidence_submitted" | "approved" | "rejected" | "paid";
  dueDate: string | null;
};

type CampaignDetails = Campaign & {
  milestones: Milestone[];
  raisedAmountCents: number;
};

type LedgerStatus = {
  valid: boolean;
  checkedEvents: number;
};

type IconName =
  | "arrow"
  | "check"
  | "chevron"
  | "close"
  | "globe"
  | "heart"
  | "leaf"
  | "lock"
  | "search"
  | "spark"
  | "users";

const HEALTHY_PLANT_SCORE = 70;

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  let payload: unknown;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error("The server returned an unreadable response.");
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Request failed (${response.status}).`;

    throw new ApiError(message, response.status);
  }

  return payload as T;
}

function Icon({
  name,
  size = 18,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const paths: Record<IconName, string> = {
    arrow: "M5 12h14m-7-7 7 7-7 7",
    check: "m5 12 4 4L19 6",
    chevron: "m9 18 6-6-6-6",
    close: "M18 6 6 18M6 6l12 12",
    globe:
      "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z",
    heart:
      "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z",
    leaf:
      "M20.8 3.2C10.7 2.8 4.4 6.1 4.4 12.3c0 3 2.3 5.3 5.2 5.3 6.2 0 9.5-6.3 9.2-14.4ZM3 21c2.4-5.8 6.2-9.5 12-12",
    lock:
      "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4m-4 4v2",
    search:
      "m21 21-4.3-4.3M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z",
    spark:
      "m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Zm7 12 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z",
    users:
      "M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m6-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm12 10v-2a4 4 0 0 0-3-3.9m-1-12.1a4 4 0 0 1 0 7.8",
  };

  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}

function formatMoney(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function percent(raised: number, goal: number) {
  if (goal <= 0) return 0;
  return Math.min(100, Math.round((raised / goal) * 100));
}

function getArtwork(cause: string) {
  const value = cause.toLowerCase();
  if (value.includes("education") || value.includes("school")) {
    return { className: "artwork--education", icon: "✳", label: "Education" };
  }
  if (value.includes("health") || value.includes("medical")) {
    return { className: "artwork--health", icon: "✚", label: "Health" };
  }
  if (
    value.includes("environment") ||
    value.includes("climate") ||
    value.includes("nature")
  ) {
    return { className: "artwork--nature", icon: "❋", label: "Environment" };
  }
  if (value.includes("community") || value.includes("housing")) {
    return { className: "artwork--community", icon: "⌂", label: "Community" };
  }
  return { className: "artwork--hope", icon: "✳", label: "Relief" };
}

function PlantArtwork({ trustScore }: { trustScore: number }) {
  const isHealthy = trustScore >= HEALTHY_PLANT_SCORE;

  return (
    <svg
      className={`plant-illustration ${isHealthy ? "plant-illustration--healthy" : "plant-illustration--wilted"}`}
      viewBox="0 0 180 140"
      role="img"
      aria-label={`Trust score ${trustScore} out of 100: ${isHealthy ? "healthy plant" : "wilted plant"}`}
    >
      <ellipse className="plant-ground" cx="90" cy="119" rx="54" ry="9" />
      {isHealthy ? (
        <g className="plant-growth">
          <path className="plant-stem" d="M90 111C89 87 92 61 90 30" />
          <path className="plant-branch" d="M90 83C76 80 66 72 61 60M91 72c14-3 23-11 27-23M90 58c-12-5-17-12-18-22M91 48c11-4 17-11 19-20" />
          <path className="plant-leaf" d="M63 63c-13 0-20-9-19-21 13-1 22 6 25 19-2 1-4 2-6 2Z" />
          <path className="plant-leaf" d="M115 52c12-2 18-11 15-23-13 1-21 9-22 22 2 1 4 1 7 1Z" />
          <path className="plant-leaf" d="M74 39c-12-4-16-14-11-25 12 4 18 13 16 26-2 0-4 0-5-1Z" />
          <path className="plant-leaf" d="M108 31c9-8 9-19 1-28-10 8-12 18-5 29 1 0 3 0 4-1Z" />
          <path className="plant-leaf plant-leaf--small" d="M98 68c8-9 18-9 26-2-8 9-17 11-27 5 0-1 0-2 1-3Z" />
        </g>
      ) : (
        <g className="plant-growth">
          <path className="plant-stem" d="M90 111c3-16 13-23 8-36-5-13 7-20 1-31-3-6-4-11-4-17" />
          <path className="plant-branch" d="M96 83c-12 1-20-3-26-11M99 68c11 1 18-3 23-10M98 54c-10-1-15-6-19-14" />
          <path className="plant-leaf" d="M72 74c-12 4-21-2-22-14 12-4 22 0 27 11-1 1-3 2-5 3Z" />
          <path className="plant-leaf" d="M117 60c12 5 20-1 21-13-12-5-22-1-27 10 2 1 4 2 6 3Z" />
          <path className="plant-leaf" d="M82 42c-11 2-18-4-18-16 12-2 21 3 24 14-2 1-4 2-6 2Z" />
          <path className="plant-leaf" d="M95 31c7-8 6-17-2-25-9 8-10 18-3 28 2-1 3-2 5-3Z" />
        </g>
      )}
      <path className="plant-pot" d="M66 103h48l-7 29H73l-7-29Z" />
      <path className="plant-pot-rim" d="M63 100h54v8H63z" />
    </svg>
  );
}

const roles: { value: Role; label: string; description: string }[] = [
  {
    value: "donor",
    label: "Supporter",
    description: "Discover causes and make a donation",
  },
  {
    value: "organizer",
    label: "Organizer",
    description: "Manage your organization’s campaigns",
  },
  {
    value: "reviewer",
    label: "Reviewer",
    description: "Review evidence and organization trust",
  },
];

function App() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [campaignError, setCampaignError] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [selectedCampaign, setSelectedCampaign] =
    useState<CampaignDetails | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState("All causes");
  const [showLogin, setShowLogin] = useState(false);
  const [loginRole, setLoginRole] = useState<Role>("donor");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [donationAmount, setDonationAmount] = useState("25");
  const [isDonating, setIsDonating] = useState(false);
  const [donationError, setDonationError] = useState("");
  const [authError, setAuthError] = useState("");
  const [ledgerStatus, setLedgerStatus] = useState<LedgerStatus | null>(null);
  const [ledgerError, setLedgerError] = useState("");
  const [paymentNotice, setPaymentNotice] = useState<{
    kind: "success" | "info" | "error";
    message: string;
  } | null>(null);

  const loadCampaigns = useCallback(async () => {
    setIsLoading(true);
    setCampaignError("");

    try {
      const result = await api<Campaign[]>("/campaigns");
      setCampaigns(result);
    } catch (error) {
      setCampaignError(
        error instanceof Error ? error.message : "Unable to load campaigns.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadLedgerStatus = useCallback(async () => {
    setLedgerError("");
    try {
      setLedgerStatus(await api<LedgerStatus>("/ledger/verify"));
    } catch (error) {
      setLedgerError(
        error instanceof Error
          ? error.message
          : "Unable to check ledger integrity.",
      );
    }
  }, []);

  useEffect(() => {
    void loadCampaigns();
    void loadLedgerStatus();

    api<{ user: User }>("/auth/me")
      .then((result) => setUser(result.user))
      .catch((error: unknown) => {
        if (!(error instanceof ApiError && error.status === 401)) {
          setAuthError(
            error instanceof Error
              ? error.message
              : "Unable to check your sign-in status.",
          );
        }
      });
  }, [loadCampaigns, loadLedgerStatus]);

  useEffect(() => {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const donationId = params.get("donationId");

    if (path === "/paypal/cancel") {
      setPaymentNotice({
        kind: "info",
        message: "Your donation was cancelled. No payment was captured.",
      });
      window.history.replaceState(null, "", "/");
      return;
    }

    if (path !== "/paypal/return") return;
    if (!donationId) {
      setPaymentNotice({
        kind: "error",
        message: "We couldn’t find the donation to confirm. Please contact support.",
      });
      return;
    }

    setPaymentNotice({
      kind: "info",
      message: "Confirming your donation securely with PayPal…",
    });

    api<{ status: string; amountCents?: number }>(
      `/donations/${encodeURIComponent(donationId)}/capture`,
      { method: "POST" },
    )
      .then((result) => {
        setPaymentNotice({
          kind: result.status === "completed" ? "success" : "info",
          message:
            result.status === "completed"
              ? "Thank you! Your donation is confirmed and recorded."
              : "Your payment is still processing. Your receipt will update when it completes.",
        });
        window.history.replaceState(null, "", "/");
        void loadCampaigns();
        void loadLedgerStatus();
      })
      .catch((error: unknown) => {
        setPaymentNotice({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "We couldn’t confirm your payment. Please try again.",
        });
      });
  }, [loadCampaigns, loadLedgerStatus]);

  const filteredCampaigns = useMemo(() => {
    const query = search.trim().toLowerCase();
    return campaigns.filter((campaign) => {
      const matchesSearch =
        !query ||
        [
          campaign.title,
          campaign.organization.name,
          campaign.organization.cause,
          campaign.organization.location,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query);
      const matchesFilter =
        activeFilter === "All causes" ||
        campaign.organization.cause
          .toLowerCase()
          .includes(activeFilter.toLowerCase());
      return matchesSearch && matchesFilter;
    });
  }, [activeFilter, campaigns, search]);

  const totalGoal = campaigns.reduce(
    (total, campaign) => total + campaign.goalAmountCents,
    0,
  );
  const verifiedOrganizations = new Set(
    campaigns
      .filter((campaign) => campaign.organization.verified)
      .map((campaign) => campaign.organization.id),
  ).size;

  async function openCampaign(campaign: Campaign) {
    setSelectedCampaign(null);
    setDetailError("");
    setDonationError("");
    setDonationAmount("25");
    setIsDetailLoading(true);

    try {
      const details = await api<CampaignDetails>(`/campaigns/${campaign.id}`);
      setSelectedCampaign(details);
    } catch (error) {
      setDetailError(
        error instanceof Error ? error.message : "Unable to load this campaign.",
      );
    } finally {
      setIsDetailLoading(false);
    }
  }

  async function signIn() {
    setIsLoggingIn(true);
    setAuthError("");

    try {
      const result = await api<{ user: User }>("/auth/demo-login", {
        method: "POST",
        body: JSON.stringify({ role: loginRole }),
      });
      setUser(result.user);
      setShowLogin(false);
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : "Unable to sign in. Please try again.",
      );
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function signOut() {
    try {
      await api<{ message: string }>("/auth/logout", { method: "POST" });
      setUser(null);
      setPaymentNotice(null);
    } catch (error) {
      setAuthError(
        error instanceof Error ? error.message : "Unable to sign out.",
      );
    }
  }

  async function donate() {
    if (!selectedCampaign) return;
    if (!user || user.role !== "donor") {
      setDonationError(
        user
          ? "Sign in as a supporter to make a donation."
          : "Sign in as a supporter to continue to PayPal.",
      );
      setLoginRole("donor");
      setShowLogin(true);
      return;
    }

    const amount = Number(donationAmount);
    const amountCents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
      setDonationError("Enter a donation amount greater than $0.");
      return;
    }

    setIsDonating(true);
    setDonationError("");

    try {
      const order = await api<{ approvalUrl: string | null }>(
        "/donations/create-order",
        {
          method: "POST",
          body: JSON.stringify({
            campaignId: selectedCampaign.id,
            amountCents,
          }),
        },
      );

      if (!order.approvalUrl) {
        throw new Error("PayPal didn’t provide an approval link for this donation.");
      }

      window.location.assign(order.approvalUrl);
    } catch (error) {
      setDonationError(
        error instanceof Error
          ? error.message
          : "Unable to start your donation. Please try again.",
      );
      setIsDonating(false);
    }
  }

  const closeCampaign = () => {
    setSelectedCampaign(null);
    setDetailError("");
    setDonationError("");
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" aria-label="ImpactLedger home">
          <span className="brand-mark">
            <Icon name="leaf" size={20} />
          </span>
          <span>impact<span className="brand-light">ledger</span></span>
        </a>

        <div className="side-label">YOUR SPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <a className="side-link side-link--active" href="#campaigns">
            <Icon name="globe" />
            <span>Explore causes</span>
          </a>
          <a className="side-link" href="#how-it-works">
            <Icon name="heart" />
            <span>How it works</span>
          </a>
          <a className="side-link" href="#trust">
            <Icon name="lock" />
            <span>Our promise</span>
          </a>
        </nav>

        <div className="sidebar-spacer" />
        <div className="sidebar-note">
          <span className="note-icon"><Icon name="spark" size={17} /></span>
          <p>Good things grow when everyone can see them.</p>
          <a href="#trust">Our transparency promise <Icon name="arrow" size={14} /></a>
        </div>
        <div className="sidebar-footer">
          <span className="online-dot" />
          <span>Every gift, accounted for</span>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            <span>ImpactLedger</span>
            <Icon name="chevron" size={14} />
            <strong>Discover</strong>
          </div>
          <div className="topbar-actions">
            <span className="secure-label"><Icon name="lock" size={14} /> Transparent by design</span>
            {user ? (
              <div className="signed-in">
                <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
                <span className="signed-in-name">{user.name}</span>
                <button className="text-button" onClick={() => void signOut()}>Sign out</button>
              </div>
            ) : (
              <button className="button button--outline button--small" onClick={() => setShowLogin(true)}>
                Sign in
              </button>
            )}
          </div>
        </header>

        {authError && (
          <div className="inline-alert inline-alert--error" role="alert">
            {authError}
            <button aria-label="Dismiss message" onClick={() => setAuthError("")}><Icon name="close" size={16} /></button>
          </div>
        )}

        {paymentNotice && (
          <div className={`payment-notice payment-notice--${paymentNotice.kind}`} role="status">
            <span>{paymentNotice.message}</span>
            <button aria-label="Dismiss message" onClick={() => setPaymentNotice(null)}><Icon name="close" size={16} /></button>
          </div>
        )}

        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-line" /> A LITTLE MORE GOOD, WITH A LOT MORE CLARITY</div>
            <h1>Give with heart.<br /><span>See the whole story.</span></h1>
            <p className="hero-description">
              Meet the people making change happen, follow every milestone, and know where your generosity goes.
            </p>
            <a className="button button--dark" href="#campaigns">
              Find a cause <Icon name="arrow" size={17} />
            </a>
            <div className="hero-proof">
              <span className="proof-avatars" aria-hidden="true"><i>A</i><i>M</i><i>J</i></span>
              <span>Small acts. <strong>Real impact.</strong></span>
            </div>
          </div>
          <div className="hero-art" aria-label="Illustration of people growing a community garden">
            <div className="hero-art-orbit hero-art-orbit--one" />
            <div className="hero-art-orbit hero-art-orbit--two" />
            <div className="hero-sun" />
            <div className="hero-plant hero-plant--left"><i /><i /><b /></div>
            <div className="hero-plant hero-plant--right"><i /><i /><b /></div>
            <div className="hero-ground" />
            <div className="hero-figure hero-figure--one"><i /><b /></div>
            <div className="hero-figure hero-figure--two"><i /><b /></div>
            <div className="hero-art-caption"><span><Icon name="spark" size={15} /></span><div><strong>Good grows here</strong><small>One thoughtful gift at a time</small></div></div>
            <span className="hero-art-star hero-art-star--one">✳</span>
            <span className="hero-art-star hero-art-star--two">✦</span>
          </div>
          <div className="hero-bottom">
            <div className="hero-bottom-label"><span>01</span> / 03 <i /> Find your cause</div>
            <div className="hero-bottom-right">MORE THAN A DONATION. A PROMISE KEPT.</div>
          </div>
        </section>

        <section className="impact-strip" aria-label="ImpactLedger at a glance">
          <div className="impact-intro"><span className="impact-spark">✳</span><span>Doing good,<br /><strong>with receipts.</strong></span></div>
          <div className="impact-stat"><strong>{isLoading ? "—" : campaigns.length}</strong><span>causes to explore</span></div>
          <div className="impact-stat"><strong>{isLoading ? "—" : verifiedOrganizations}</strong><span>verified organizations</span></div>
          <div className="impact-stat"><strong>{isLoading ? "—" : formatMoney(totalGoal)}</strong><span>in community goals</span></div>
          <div className="impact-status">
            <span className={`status-mark ${ledgerStatus?.valid ? "status-mark--good" : ""}`}>
              {ledgerStatus?.valid ? <Icon name="check" size={15} /> : <Icon name="lock" size={15} />}
            </span>
            <span>{ledgerError ? "Ledger check unavailable" : ledgerStatus ? (ledgerStatus.valid ? "Ledger verified" : "Ledger needs review") : "Checking ledger…"}</span>
            {ledgerStatus && <small>{ledgerStatus.checkedEvents} records checked</small>}
          </div>
        </section>

        <section className="discover-section" id="campaigns">
          <div className="section-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> GOOD WORK, HAPPENING NOW</div>
              <h2>Find the good you want to grow.</h2>
              <p>Every campaign is connected to a real organization, real milestones, and a transparent ledger.</p>
            </div>
            <div className="campaign-count"><span>{filteredCampaigns.length.toString().padStart(2, "0")}</span> campaigns</div>
          </div>

          <div className="browse-tools">
            <div className="filter-list" aria-label="Filter campaigns by cause">
              {["All causes", "Education", "Health", "Environment", "Community"].map((filter) => (
                <button
                  key={filter}
                  className={`filter-chip ${activeFilter === filter ? "filter-chip--active" : ""}`}
                  onClick={() => setActiveFilter(filter)}
                  aria-pressed={activeFilter === filter}
                >
                  {filter === "All causes" && <Icon name="spark" size={14} />}
                  {filter}
                </button>
              ))}
            </div>
            <label className="search-field">
              <Icon name="search" size={17} />
              <input
                type="search"
                placeholder="Search causes or places"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Search campaigns"
              />
              <kbd>/</kbd>
            </label>
          </div>

          {isLoading ? (
            <div className="campaign-grid" aria-label="Loading campaigns">
              {[1, 2, 3].map((item) => <div className="campaign-skeleton" key={item}><div /><span /><span /></div>)}
            </div>
          ) : campaignError ? (
            <div className="empty-state">
              <span className="empty-icon"><Icon name="globe" size={23} /></span>
              <h3>We couldn’t load the campaigns just yet.</h3>
              <p>{campaignError}</p>
              <button className="button button--dark" onClick={() => void loadCampaigns()}>Try again <Icon name="arrow" size={16} /></button>
            </div>
          ) : filteredCampaigns.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon"><Icon name="search" size={23} /></span>
              <h3>No matching causes yet.</h3>
              <p>Try another search or browse all campaigns.</p>
              <button className="button button--outline" onClick={() => { setSearch(""); setActiveFilter("All causes"); }}>Clear filters</button>
            </div>
          ) : (
            <div className="campaign-grid">
              {filteredCampaigns.map((campaign) => {
                const art = getArtwork(campaign.organization.cause);
                const isHealthy = campaign.organization.trustScore >= HEALTHY_PLANT_SCORE;
                return (
                  <article className="campaign-card" key={campaign.id}>
                    <button className={`campaign-artwork ${art.className} ${isHealthy ? "campaign-artwork--healthy" : "campaign-artwork--wilted"}`} onClick={() => void openCampaign(campaign)} aria-label={`View ${campaign.title}; organization trust score ${campaign.organization.trustScore} out of 100`}>
                      <span className="artwork-label">{isHealthy ? "Thriving · score " : "Needs care · score "}{campaign.organization.trustScore}</span>
                      <PlantArtwork trustScore={campaign.organization.trustScore} />
                      <span className="artwork-shape artwork-shape--one" />
                      <span className="artwork-shape artwork-shape--two" />
                      <span className="artwork-corner"><Icon name="arrow" size={17} /></span>
                    </button>
                    <div className="campaign-card-body">
                      <div className="organization-line">
                        <span className="org-avatar">{campaign.organization.name.slice(0, 1).toUpperCase()}</span>
                        <span>{campaign.organization.name}</span>
                        {campaign.organization.verified && <span className="verified-check" title="Verified organization"><Icon name="check" size={12} /></span>}
                      </div>
                      <button className="campaign-title" onClick={() => void openCampaign(campaign)}>{campaign.title}</button>
                      <p className="campaign-description">{campaign.organization.cause} <span>·</span> {campaign.organization.location}</p>
                      <div className="campaign-meta">
                        <span><Icon name="users" size={14} /> {campaign._count.donations} supporters</span>
                        <span className={`campaign-status campaign-status--${campaign.status}`}>{campaign.status.replace("_", " ")}</span>
                      </div>
                      <div className="campaign-card-bottom">
                        <span className="campaign-goal-label">GOAL</span>
                        <strong>{formatMoney(campaign.goalAmountCents, campaign.currency)}</strong>
                        <span className="campaign-milestones">{campaign._count.milestones} milestones</span>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="how-section" id="how-it-works">
          <div className="how-heading">
            <div className="eyebrow"><span className="eyebrow-line" /> SIMPLE TO GIVE. EASY TO FOLLOW.</div>
            <h2>From your heart<br />to the heart of it.</h2>
          </div>
          <div className="how-steps">
            <article><span className="step-number">01</span><span className="step-icon"><Icon name="heart" /></span><h3>Choose a cause</h3><p>Find a campaign and see who’s behind it before you give.</p></article>
            <article><span className="step-number">02</span><span className="step-icon"><Icon name="spark" /></span><h3>Give with confidence</h3><p>Your secure donation supports a goal with clear milestones.</p></article>
            <article><span className="step-number">03</span><span className="step-icon"><Icon name="globe" /></span><h3>Follow the impact</h3><p>Review progress, submitted evidence, and a tamper-evident ledger.</p></article>
          </div>
        </section>

        <section className="trust-section" id="trust">
          <div className="trust-art">
            <span className="trust-orbit" />
            <span className="trust-leaf trust-leaf--one">✳</span>
            <span className="trust-leaf trust-leaf--two">❋</span>
            <span className="trust-center"><Icon name="lock" size={25} /></span>
          </div>
          <div className="trust-copy">
            <div className="eyebrow"><span className="eyebrow-line" /> TRUST ISN’T A PROMISE. IT’S A PRACTICE.</div>
            <h2>Good intentions deserve good transparency.</h2>
            <p>Organizations build a trust profile. Campaigns are organized into milestones. And every key action is added to a verifiable ledger, so your generosity never disappears into a black box.</p>
            <div className="trust-points">
              <span><i><Icon name="check" size={13} /></i> Verified organizations</span>
              <span><i><Icon name="check" size={13} /></i> Milestone-based progress</span>
              <span><i><Icon name="check" size={13} /></i> Tamper-evident records</span>
            </div>
          </div>
        </section>

        <footer className="footer">
          <a className="brand brand--footer" href="#"><span className="brand-mark"><Icon name="leaf" size={17} /></span><span>impact<span className="brand-light">ledger</span></span></a>
          <span>More good. Less guesswork.</span>
          <span>© 2026 ImpactLedger</span>
        </footer>
      </main>

      {(showLogin || selectedCampaign || isDetailLoading || detailError) && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setShowLogin(false); closeCampaign(); } }}>
          {showLogin ? (
            <section className="modal login-modal" role="dialog" aria-modal="true" aria-labelledby="login-title">
              <button className="modal-close" aria-label="Close sign in" onClick={() => { setShowLogin(false); setAuthError(""); }}><Icon name="close" /></button>
              <span className="modal-kicker"><Icon name="spark" size={15} /> WELCOME TO IMPACTLEDGER</span>
              <h2 id="login-title">Good to have you here.</h2>
              <p className="modal-intro">Choose a demo role to explore the platform. You can change roles any time by signing out.</p>
              <div className="role-options">
                {roles.map((role) => (
                  <button key={role.value} className={`role-option ${loginRole === role.value ? "role-option--active" : ""}`} onClick={() => setLoginRole(role.value)}>
                    <span className="role-radio">{loginRole === role.value && <i />}</span>
                    <span className="role-copy"><strong>{role.label}</strong><small>{role.description}</small></span>
                    <Icon name="chevron" size={17} />
                  </button>
                ))}
              </div>
              {authError && <p className="form-error" role="alert">{authError}</p>}
              <button className="button button--dark button--wide" onClick={() => void signIn()} disabled={isLoggingIn}>
                {isLoggingIn ? "Signing you in…" : "Continue with demo access"} <Icon name="arrow" size={16} />
              </button>
              <p className="privacy-note"><Icon name="lock" size={13} /> Demo sign-in uses a secure session cookie.</p>
            </section>
          ) : (
            <section className="modal campaign-modal" role="dialog" aria-modal="true" aria-labelledby="detail-title">
              <button className="modal-close" aria-label="Close campaign details" onClick={closeCampaign}><Icon name="close" /></button>
              {isDetailLoading ? (
                <div className="detail-loading"><div className="loading-spinner" /><span>Loading campaign details…</span></div>
              ) : detailError ? (
                <div className="detail-error"><h2>Campaign details unavailable</h2><p>{detailError}</p><button className="button button--outline" onClick={closeCampaign}>Close</button></div>
              ) : selectedCampaign ? (
                <>
                  <div className={`detail-art ${getArtwork(selectedCampaign.organization.cause).className} ${selectedCampaign.organization.trustScore >= HEALTHY_PLANT_SCORE ? "detail-art--healthy" : "detail-art--wilted"}`}>
                    <span className="artwork-label">{selectedCampaign.organization.trustScore >= HEALTHY_PLANT_SCORE ? "Thriving organization" : "Organization needs care"}</span>
                    <PlantArtwork trustScore={selectedCampaign.organization.trustScore} />
                  </div>
                  <div className="detail-content">
                    <div className="organization-line">
                      <span className="org-avatar">{selectedCampaign.organization.name.slice(0, 1).toUpperCase()}</span>
                      <span>{selectedCampaign.organization.name}</span>
                      {selectedCampaign.organization.verified && <span className="verified-check" title="Verified organization"><Icon name="check" size={12} /></span>}
                      <span className="trust-score"><Icon name="spark" size={13} /> Trust score {selectedCampaign.organization.trustScore}</span>
                    </div>
                    <h2 id="detail-title">{selectedCampaign.title}</h2>
                    <p className="detail-location">{selectedCampaign.organization.cause} <span>·</span> {selectedCampaign.organization.location}</p>
                    <p className="detail-description">Your support helps {selectedCampaign.organization.name} move this work forward. Follow the campaign’s milestones and see how progress is documented along the way.</p>

                    <div className="detail-progress">
                      <div className="progress-label"><span>Raised so far</span><strong>{formatMoney(selectedCampaign.raisedAmountCents, selectedCampaign.currency)}</strong></div>
                      <div className="progress-track"><span style={{ width: `${percent(selectedCampaign.raisedAmountCents, selectedCampaign.goalAmountCents)}%` }} /></div>
                      <div className="progress-foot"><span>{percent(selectedCampaign.raisedAmountCents, selectedCampaign.goalAmountCents)}% of goal</span><span>Goal {formatMoney(selectedCampaign.goalAmountCents, selectedCampaign.currency)}</span></div>
                    </div>

                    <div className="milestone-list">
                      <div className="milestone-heading"><strong>Campaign milestones</strong><span>{selectedCampaign.milestones.length} steps</span></div>
                      {selectedCampaign.milestones.length ? selectedCampaign.milestones.map((milestone) => (
                        <div className="milestone-row" key={milestone.id}>
                          <span className={`milestone-dot milestone-dot--${milestone.status}`} />
                          <span className="milestone-title">{milestone.title}</span>
                          <span className="milestone-status">{milestone.status.replace("_", " ")}</span>
                          <strong>{formatMoney(milestone.budgetAmountCents, selectedCampaign.currency)}</strong>
                        </div>
                      )) : <p className="no-milestones">Milestones will appear here as this campaign is organized.</p>}
                    </div>

                    {selectedCampaign.status === "active" ? (
                      <div className="donation-box">
                        <label htmlFor="donation-amount">Make a difference today</label>
                        <div className="donation-controls">
                          <div className="amount-field"><span>$</span><input id="donation-amount" type="number" min="0.01" step="0.01" value={donationAmount} onChange={(event) => setDonationAmount(event.target.value)} /></div>
                          <button className="button button--dark" onClick={() => void donate()} disabled={isDonating}>
                            {isDonating ? "Connecting…" : "Continue to PayPal"} <Icon name="arrow" size={16} />
                          </button>
                        </div>
                        {donationError && <p className="form-error" role="alert">{donationError}</p>}
                        <p className="donation-secure"><Icon name="lock" size={13} /> Secure checkout powered by PayPal</p>
                      </div>
                    ) : (
                      <p className="campaign-inactive">This campaign is {selectedCampaign.status} and isn’t currently accepting donations.</p>
                    )}
                  </div>
                </>
              ) : null}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
