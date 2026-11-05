import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type DashboardSummary } from "../api/client";
import { useAuth } from "../auth";

type CustomWidget = "trust" | "flags" | "funding" | "spend";

const widgetPrompts: { match: RegExp; type: CustomWidget }[] = [
  { match: /trust|score|organization/i, type: "trust" },
  { match: /flag|review|evidence/i, type: "flags" },
  { match: /gap|funding|goal/i, type: "funding" },
  { match: /spend|category|cause|month/i, type: "spend" },
];

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

function formatCompact(cents: number) {
  const dollars = cents / 100;
  return dollars >= 1000 ? `$${(dollars / 1000).toFixed(1)}k` : money(cents);
}

function DonationsChart({ data }: { data: DashboardSummary["donationsOverTime"] }) {
  const max = Math.max(...data.map((item) => item.amountCents), 1);
  const points = data.map((item, index) => {
    const x = data.length <= 1 ? 50 : 8 + (index / (data.length - 1)) * 84;
    const y = 84 - (item.amountCents / max) * 65;
    return `${x},${y}`;
  }).join(" ");
  const areaPoints = `8,90 ${points} 92,90`;
  return (
    <div className="chart-area">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Donations over time line chart" role="img">
        <defs><linearGradient id="donationFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#92ac71" stopOpacity=".33" /><stop offset="1" stopColor="#92ac71" stopOpacity="0" /></linearGradient></defs>
        {[20, 42, 64, 86].map((y) => <line key={y} x1="6" x2="94" y1={y} y2={y} stroke="#edf0e9" strokeWidth=".6" />)}
        <polygon points={areaPoints} fill="url(#donationFill)" />
        <polyline points={points} fill="none" stroke="#698a58" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {data.map((item, index) => {
          const x = data.length <= 1 ? 50 : 8 + (index / (data.length - 1)) * 84;
          const y = 84 - (item.amountCents / max) * 65;
          return <circle key={item.label} cx={x} cy={y} r="1.5" fill="#fff" stroke="#698a58" strokeWidth=".8" vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
      <div className="chart-labels">{data.map((item) => <span key={item.label}>{item.label}</span>)}</div>
    </div>
  );
}

function DashboardWidget({
  title,
  subtitle,
  children,
  className = "",
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  className?: string;
}) {
  return <article className={`dashboard-widget ${className}`}><header><div><h2>{title}</h2><p>{subtitle}</p></div><button className="widget-menu" aria-label={`Options for ${title}`}>···</button></header>{children}</article>;
}

function CustomWidgetView({ type, summary }: { type: CustomWidget; summary: DashboardSummary }) {
  if (type === "trust") return <div className="custom-widget-content">{summary.trustScores.slice(0, 4).map((item) => <div className="compact-row" key={item.organization}><span>{item.organization}</span><strong>{item.score}<small>/100</small></strong></div>)}</div>;
  if (type === "flags") return <div className="custom-widget-content">{summary.flags.map((item) => <div className="flag-row" key={item.id}><span className={`flag-severity flag-severity--${item.severity}`} /><div><strong>{item.title}</strong><small>{item.detail}</small></div></div>)}</div>;
  if (type === "funding") return <div className="custom-widget-content">{summary.fundingGaps.slice(0, 4).map((item) => <div className="compact-row" key={item.campaignId}><span>{item.title}</span><strong>{money(item.gapAmountCents)}</strong></div>)}</div>;
  return <div className="custom-widget-content">{summary.spendByCause.map((item) => <div className="compact-row" key={item.cause}><span>{item.cause}</span><strong>{money(item.amountCents)}</strong></div>)}</div>;
}

export function DashboardPage() {
  const { user, openSignIn } = useAuth();
  const [range, setRange] = useState<"month" | "quarter" | "half">("half");
  const [cause, setCause] = useState("All causes");
  const [widgetPrompt, setWidgetPrompt] = useState("");
  const [customWidget, setCustomWidget] = useState<CustomWidget | null>(null);
  const [agentMessage, setAgentMessage] = useState("");
  const summaryQuery = useQuery({
    queryKey: ["dashboard", "summary", range, cause],
    queryFn: () => api.getDashboardSummary(range, cause),
    enabled: Boolean(user),
  });
  const summary = summaryQuery.data;

  const filteredDonations = useMemo(() => {
    const data = summary?.donationsOverTime ?? [];
    return data.slice(range === "month" ? -1 : range === "quarter" ? -3 : -6);
  }, [range, summary]);
  const filteredSpend = summary?.spendByCause ?? [];

  function addWidget() {
    const widget = widgetPrompts.find((item) => item.match.test(widgetPrompt));
    if (!widget) {
      setAgentMessage("Try “show spend by category”, “trust scores”, “funding gaps”, or “review flags”.");
      return;
    }
    setCustomWidget(widget.type);
    setAgentMessage(`Added a ${widget.type} widget from your request.`);
  }

  if (!user) return <div className="empty-state access-state"><span className="empty-icon">♧</span><h3>Sign in to see the dashboard.</h3><p>Demo activity and review summaries are available to signed-in roles.</p><button className="button button--dark" onClick={() => openSignIn()}>Sign in to continue</button></div>;
  if (summaryQuery.isPending) return <div className="page-loading"><span className="loading-spinner" /> Loading impact dashboard…</div>;
  if (summaryQuery.isError || !summary) {
    return <div className="empty-state access-state"><h3>Dashboard data unavailable</h3><p>{summaryQuery.error?.message ?? "The dashboard summary could not be loaded."}</p><button className="button button--dark" onClick={() => void summaryQuery.refetch()}>Try again</button></div>;
  }

  const maxSpend = Math.max(...filteredSpend.map((item) => item.amountCents), 1);
  const maxGap = Math.max(...summary.fundingGaps.map((item) => item.gapAmountCents), 1);
  const averageTrust = Math.round(summary.trustScores.reduce((total, item) => total + item.score, 0) / Math.max(summary.trustScores.length, 1));

  return (
    <div className="dashboard-page">
      <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> IMPACT AT A GLANCE</div><h1>Good work, in focus.</h1><p>Seeded demo activity across donations, campaigns, trust, and evidence.</p></div><Link className="button button--outline" to="/">Explore campaigns ↗</Link></section>
      <div className="dashboard-filter-bar"><span>View period</span><div className="range-toggle">{(["month", "quarter", "half"] as const).map((item) => <button key={item} className={range === item ? "range-toggle--active" : ""} onClick={() => setRange(item)}>{item === "month" ? "This month" : item === "quarter" ? "Quarter" : "6 months"}</button>)}</div><label className="select-filter"><span>Cause</span><select value={cause} onChange={(event) => setCause(event.target.value)}><option>All causes</option>{["Education", "Environment", "Healthcare", "Water and Sanitation", "Women Empowerment", "Livelihoods", "Animal Welfare", "Hunger Relief"].map((item) => <option key={item}>{item}</option>)}</select></label><span className="dashboard-updated">Updated just now · Demo data</span></div>

      <section className="dashboard-kpis">
        <article><span>CAMPAIGNS</span><strong>{summary.totals.campaignCount}</strong><small>Active across causes</small></article>
        <article><span>COMPLETED GIFTS</span><strong>{money(summary.totals.completedDonationCents)}</strong><small>Recorded donations</small></article>
        <article><span>AVERAGE TRUST</span><strong>{averageTrust}<small>/100</small></strong><small>Across {summary.trustScores.length} organizations</small></article>
        <article><span>PAID OUT</span><strong>{money(summary.totals.paidPayoutCents)}</strong><small>{summary.totals.pendingEvidenceCount} evidence item to review</small></article>
      </section>

      <section className="dashboard-grid">
        <DashboardWidget title="Donations over time" subtitle="Completed gifts · USD" className="widget-donations">
          <div className="widget-chart-total"><strong>{money(filteredDonations.reduce((total, item) => total + item.amountCents, 0))}</strong><span>in selected period</span></div>
          <DonationsChart data={filteredDonations} />
        </DashboardWidget>
        <DashboardWidget title="Spend by cause" subtitle="Donation allocation · USD" className="widget-spend">
          <div className="widget-chart-total"><strong>{money(filteredSpend.reduce((total, item) => total + item.amountCents, 0))}</strong><span>{cause === "All causes" ? "across all causes" : cause}</span></div>
          <div className="horizontal-bars">{filteredSpend.map((item, index) => <div className="horizontal-bar-row" key={item.cause}><span>{item.cause}</span><div><i style={{ width: `${item.amountCents / maxSpend * 100}%`, background: ["#79965d", "#8ba978", "#a9ba8a", "#c5cfaa"][index % 4] }} /></div><strong>{formatCompact(item.amountCents)}</strong></div>)}</div>
        </DashboardWidget>
        <DashboardWidget title="Funding gaps" subtitle="Remaining campaign goals" className="widget-funding">
          <div className="vertical-bars">{summary.fundingGaps.slice(0, 5).map((item, index) => <div className="vertical-bar-column" key={item.campaignId}><strong>{formatCompact(item.gapAmountCents)}</strong><i style={{ height: `${Math.max(8, item.gapAmountCents / maxGap * 100)}%`, opacity: 1 - index * .1 }} /><span title={item.title}>{item.title.split(" ").slice(0, 2).join(" ")}</span></div>)}</div>
          <Link className="widget-link" to="/">View campaign marketplace →</Link>
        </DashboardWidget>
        <DashboardWidget title="Organization trust" subtitle="Score out of 100" className="widget-trust">
          <div className="trust-score-list">{summary.trustScores.slice().sort((a, b) => b.score - a.score).slice(0, 6).map((item) => <div key={item.organization}><span className="trust-org-avatar">{item.organization[0]}</span><span className="trust-org-name">{item.organization}</span><div className="mini-score-track"><i style={{ width: `${item.score}%` }} /></div><strong>{item.score}</strong></div>)}</div>
        </DashboardWidget>
        <DashboardWidget title="Review flags" subtitle={`${summary.flags.length} items need a closer look`} className="widget-flags">
          <div className="flag-list">{summary.flags.map((item) => <div className="flag-row" key={item.id}><span className={`flag-severity flag-severity--${item.severity}`} /><div><strong>{item.title}</strong><small>{item.detail}</small></div><span className={`flag-tag flag-tag--${item.severity}`}>{item.severity}</span></div>)}</div>
          <Link className="widget-link" to="/reviewer">Open reviewer queue →</Link>
        </DashboardWidget>
        {customWidget && <DashboardWidget title={`Custom · ${customWidget}`} subtitle="Generated from your request" className="widget-custom"><CustomWidgetView type={customWidget} summary={summary} /></DashboardWidget>}
      </section>

      <section className="studio-agent-panel">
        <span className="studio-agent-icon">✦</span>
        <div className="studio-agent-copy"><div className="eyebrow"><span className="eyebrow-line" /> DASHBOARD STUDIO</div><h2>Make this dashboard yours.</h2><p>Describe a widget and add it to your view.</p></div>
        <div className="studio-agent-form"><label htmlFor="widget-request">Ask for a widget</label><div><input id="widget-request" value={widgetPrompt} onChange={(event) => setWidgetPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addWidget(); }} placeholder="“Show spend by category this month”" /><button className="button button--dark" onClick={addWidget}>Build widget <span>→</span></button></div>{agentMessage && <small role="status">{agentMessage}</small>}</div>
      </section>
      <p className="dashboard-footnote">ImpactLedger demo analytics · Verify transaction records from an <Link to="/">Impact Receipt</Link>.</p>
    </div>
  );
}
