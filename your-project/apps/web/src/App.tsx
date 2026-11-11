import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  NavLink,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { api, ApiError, type User } from "./api/client";
import { AuthContext, useAuth } from "./auth";
const CampaignPage = lazy(() => import("./pages/CampaignPage").then((module) => ({ default: module.CampaignPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const MarketplacePage = lazy(() => import("./pages/MarketplacePage").then((module) => ({ default: module.MarketplacePage })));
const OrganizerPage = lazy(() => import("./pages/OrganizerPage").then((module) => ({ default: module.OrganizerPage })));
const ReceiptPage = lazy(() => import("./pages/ReceiptPage").then((module) => ({ default: module.ReceiptPage })));
const ReviewerPage = lazy(() => import("./pages/ReviewerPage").then((module) => ({ default: module.ReviewerPage })));
const TracePage = lazy(() => import("./pages/TracePage").then((module) => ({ default: module.TracePage })));
const TrustProfilePage = lazy(() => import("./pages/TrustProfilePage").then((module) => ({ default: module.TrustProfilePage })));

const roleLabels: Record<User["role"], string> = {
  donor: "Supporter",
  organizer: "Organizer",
  reviewer: "Reviewer",
};

function AppLayout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedRole, setSelectedRole] = useState<User["role"]>("donor");
  const [authError, setAuthError] = useState("");
  const [apiErrorToast, setApiErrorToast] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const userQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: api.getMe,
    retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 1,
  });
  const user = userQuery.data?.user ?? null;
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: ({ user: signedInUser }) => {
      queryClient.setQueryData(["auth", "me"], { user: signedInUser });
      void queryClient.invalidateQueries();
      setAuthError("");
      setDialogOpen(false);
    },
    onError: (error) => setAuthError(error instanceof Error ? error.message : "Unable to sign in."),
  });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.setQueryData(["auth", "me"], undefined);
      void queryClient.invalidateQueries();
      navigate("/");
    },
    onError: (error) => setAuthError(error instanceof Error ? error.message : "Unable to sign out."),
  });

  useEffect(() => {
    function showApiError(event: Event) {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      if (message) setApiErrorToast(message);
    }

    window.addEventListener("impactledger:api-error", showApiError);
    return () => window.removeEventListener("impactledger:api-error", showApiError);
  }, []);

  useEffect(() => {
    if (!apiErrorToast) return;
    const timer = window.setTimeout(() => setApiErrorToast(""), 6000);
    return () => window.clearTimeout(timer);
  }, [apiErrorToast]);

  useEffect(() => {
    if (!dialogOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    function manageDialogKeys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDialogOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", manageDialogKeys);
    return () => {
      document.removeEventListener("keydown", manageDialogKeys);
      previousFocus?.focus();
    };
  }, [dialogOpen]);

  function openSignIn(role: User["role"] = "donor") {
    setSelectedRole(role);
    setAuthError("");
    setDialogOpen(true);
  }

  const context = { user, openSignIn };
  const navItems = user?.role === "organizer"
    ? [
        { to: "/", label: "Marketplace", icon: "◉" },
        { to: "/organizer", label: "Organizer studio", icon: "⌂" },
        { to: "/dashboard", label: "Impact dashboard", icon: "▥" },
      ]
    : user?.role === "reviewer"
      ? [
          { to: "/", label: "Marketplace", icon: "◉" },
          { to: "/reviewer", label: "Review queue", icon: "✓" },
          { to: "/dashboard", label: "Impact dashboard", icon: "▥" },
        ]
      : [
          { to: "/", label: "Marketplace", icon: "◉" },
          { to: "/dashboard", label: "Impact dashboard", icon: "▥" },
        ];

  return (
    <AuthContext.Provider value={context}>
      <div className="app-shell">
        <a className="skip-link" href="#main-content">Skip to content</a>
        <aside className="sidebar">
          <Link className="brand" to="/" aria-label="ImpactLedger home">
            <span className="brand-mark">✳</span>
            <span>impact<span className="brand-light">ledger</span></span>
          </Link>
          <div className="side-label">YOUR SPACE</div>
          <nav className="side-nav" aria-label="Main navigation">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) => `side-link ${isActive ? "side-link--active" : ""}`}
              >
                <span className="side-icon" aria-hidden="true">{item.icon}</span>
                <span>{item.label}</span>
              </NavLink>
            ))}
            <a className="side-link" href="/#how-it-works"><span className="side-icon">♡</span><span>How it works</span></a>
          </nav>
          <div className="sidebar-spacer" />
          <div className="sidebar-note">
            <span className="note-icon">✦</span>
            <p>Good things grow when everyone can see them.</p>
            <a href="/#trust">Our transparency promise <span aria-hidden="true">→</span></a>
          </div>
          <div className="sidebar-footer"><span className="online-dot" /> Every gift, accounted for</div>
        </aside>

        <main className="main-content" id="main-content" tabIndex={-1}>
          <header className="topbar">
            <div className="breadcrumb"><Link to="/">ImpactLedger</Link><span>›</span><strong>Good, made visible</strong></div>
            <div className="topbar-actions">
              <span className="secure-label">♧ Transparent by design</span>
              {user ? (
                <div className="signed-in">
                  <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
                  <span className="signed-in-name">{user.name}</span>
                  <span className="role-tag">{roleLabels[user.role]}</span>
                  <button className="text-button" onClick={() => openSignIn(user.role)}>Switch role</button>
                  <button className="text-button" onClick={() => logout.mutate()} disabled={logout.isPending}>
                    {logout.isPending ? "Signing out…" : "Sign out"}
                  </button>
                </div>
              ) : (
                <button className="button button--outline button--small" onClick={() => openSignIn()}>Sign in</button>
              )}
            </div>
          </header>
          <Outlet />
        </main>

        {dialogOpen && (
          <div className="modal-backdrop" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDialogOpen(false);
          }}>
            <section className="modal login-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="login-title">
              <button className="modal-close" aria-label="Close sign in" onClick={() => setDialogOpen(false)}>×</button>
              <span className="modal-kicker">✦ WELCOME TO IMPACTLEDGER</span>
              <h2 id="login-title">Choose your demo role.</h2>
              <p className="modal-intro">Switching roles updates your navigation and access.</p>
              <div className="role-options">
                {(["donor", "organizer", "reviewer"] as const).map((role) => (
                  <button
                    key={role}
                    className={`role-option ${selectedRole === role ? "role-option--active" : ""}`}
                    aria-pressed={selectedRole === role}
                    onClick={() => setSelectedRole(role)}
                  >
                    <span className="role-radio">{selectedRole === role && <i />}</span>
                    <span className="role-copy"><strong>{roleLabels[role]}</strong><small>{role === "donor" ? "Discover causes and make a donation" : role === "organizer" ? "Manage campaigns and submit evidence" : "Review evidence and approve payouts"}</small></span>
                    <span aria-hidden="true">›</span>
                  </button>
                ))}
              </div>
              {authError && <p className="form-error" role="alert">{authError}</p>}
              <button className="button button--dark button--wide" disabled={login.isPending} onClick={() => login.mutate(selectedRole)}>
                {login.isPending ? "Signing you in…" : "Continue with demo access"} <span aria-hidden="true">→</span>
              </button>
              <p className="privacy-note">Demo access is stored in a local session.</p>
            </section>
          </div>
        )}
        {apiErrorToast && (
          <div className="api-error-toast" role="alert">
            <span>{apiErrorToast}</span>
            <button type="button" aria-label="Dismiss error" onClick={() => setApiErrorToast("")}>×</button>
          </div>
        )}
      </div>
    </AuthContext.Provider>
  );
}

export function RequireRole({ role, children }: { role: User["role"]; children: ReactNode }) {
  const { user, openSignIn } = useAuth();
  if (!user) {
    return (
      <div className="empty-state access-state">
        <span className="empty-icon">♧</span>
        <h3>Sign in to continue</h3>
        <p>This area is available to {roleLabels[role].toLowerCase()} accounts.</p>
        <button className="button button--dark" onClick={() => openSignIn(role)}>Sign in as {roleLabels[role]}</button>
      </div>
    );
  }
  if (user.role !== role) {
    return (
      <div className="empty-state access-state">
        <span className="empty-icon">♧</span>
        <h3>{roleLabels[role]} access only</h3>
        <p>You’re signed in as a {roleLabels[user.role].toLowerCase()}. Switch roles to open this area.</p>
        <button className="button button--dark" onClick={() => openSignIn(role)}>Switch to {roleLabels[role]}</button>
      </div>
    );
  }
  return children;
}

function PaymentReturnPage() {
  const { openSignIn } = useAuth();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const donationId = search.get("donationId");
  const [error, setError] = useState("");
  const capture = useMutation({
    mutationFn: () => {
      if (!donationId) throw new Error("The donation ID is missing from PayPal’s return link.");
      return api.captureDonation(donationId);
    },
    onSuccess: () => {
      if (donationId) navigate(`/receipt/${donationId}`, { replace: true });
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : "Payment confirmation failed."),
  });

  useEffect(() => {
    if (capture.isIdle) capture.mutate();
  }, [capture.isIdle, capture.mutate]);

  return (
    <section className="empty-state access-state">
      <span className="empty-icon">♡</span>
      <h3>{error ? "We couldn’t confirm your payment" : "Confirming your donation…"}</h3>
      <p>{error || "Please wait while we securely confirm your PayPal payment."}</p>
      {error && <button className="button button--dark" onClick={() => openSignIn("donor")}>Sign in as supporter</button>}
    </section>
  );
}

function NotFoundPage() {
  return (
    <div className="empty-state access-state">
      <span className="empty-icon">?</span>
      <h3>We couldn’t find that page.</h3>
      <p>Pick up where you left off and explore the marketplace.</p>
      <Link className="button button--dark" to="/">Explore causes</Link>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<div className="page-loading"><span className="loading-spinner" /> Loading page…</div>}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<MarketplacePage />} />
          <Route path="marketplace" element={<MarketplacePage />} />
          <Route path="campaigns/:campaignId" element={<CampaignPage />} />
          <Route path="receipt/:donationId" element={<ReceiptPage />} />
          <Route path="trace/:donationId" element={<TracePage />} />
          <Route path="organizations/:organizationId/trust" element={<TrustProfilePage />} />
          <Route path="organizer" element={<RequireRole role="organizer"><OrganizerPage /></RequireRole>} />
          <Route path="reviewer" element={<RequireRole role="reviewer"><ReviewerPage /></RequireRole>} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="paypal/return" element={<PaymentReturnPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
