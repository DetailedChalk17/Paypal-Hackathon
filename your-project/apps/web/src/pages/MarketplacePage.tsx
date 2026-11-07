import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type SuggestedSplit } from "../api/client";
import { PlantArtwork } from "../components/PlantArtwork";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

export function MarketplacePage() {
  const campaignsQuery = useQuery({ queryKey: ["campaigns"], queryFn: api.getCampaigns });
  const campaigns = campaignsQuery.data ?? [];
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [cause, setCause] = useState("All causes");
  const [location, setLocation] = useState("All locations");
  const [goal, setGoal] = useState("Support rural education and clean water");
  const [amount, setAmount] = useState("50");
  const [split, setSplit] = useState<SuggestedSplit[]>([]);
  const [routingError, setRoutingError] = useState("");
  const [routingNotice, setRoutingNotice] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const locations = useMemo(
    () => ["All locations", ...new Set(campaigns.map((campaign) => campaign.organization.location))],
    [campaigns],
  );
  const causes = useMemo(
    () => ["All causes", ...new Set(campaigns.map((campaign) => campaign.organization.cause))],
    [campaigns],
  );
  const visibleCampaigns = useMemo(() => campaigns
    .filter((campaign) => {
      const haystack = `${campaign.title} ${campaign.organization.name} ${campaign.organization.cause} ${campaign.organization.location}`.toLowerCase();
      return (!debouncedSearch || haystack.includes(debouncedSearch)) &&
        (cause === "All causes" || campaign.organization.cause === cause) &&
        (location === "All locations" || campaign.organization.location === location);
    })
    .sort((a, b) => {
      const score = (campaign: typeof a) => {
        const gapPercent = campaign.raisedAmountCents === undefined
          ? 0
          : Math.max(0, (campaign.goalAmountCents - campaign.raisedAmountCents) / Math.max(campaign.goalAmountCents, 1)) * 100;
        return campaign.organization.trustScore * 0.6 + gapPercent * 0.4;
      };
      return score(b) - score(a);
    }),
  [campaigns, cause, debouncedSearch, location]);

  const suggest = useMutation({
    mutationFn: () => api.getSuggestedSplit(goal, Math.round(Number(amount) * 100)),
    onSuccess: ({ suggestions }) => {
      setSplit(suggestions);
      setRoutingError("");
      setRoutingNotice("");
    },
    onError: (error) => {
      setRoutingError(error instanceof Error ? error.message : "Unable to suggest a split.");
      setSplit([]);
    },
  });

  const splitTotal = split.reduce((total, item) => total + item.amountCents, 0);

  function updateSplit(index: number, value: string) {
    setSplit((current) => current.map((item, itemIndex) =>
      itemIndex === index
        ? { ...item, amountCents: Math.max(0, Math.round(Number(value) * 100) || 0) }
        : item,
    ));
    setRoutingNotice("");
  }

  function approveSplit() {
    setRoutingNotice(`Your ${money(splitTotal)} plan is ready. Sign in as a supporter to complete your donations.`);
  }

  return (
    <>
      <section className="market-hero">
        <div className="market-hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> A LITTLE MORE GOOD, WITH A LOT MORE CLARITY</div>
          <h1>Give with heart.<br /><span>See the whole story.</span></h1>
          <p>Meet the people making change happen, follow every milestone, and know where your generosity goes.</p>
          <a className="button button--dark" href="#campaigns">Find your cause <span>→</span></a>
          <div className="hero-proof"><span className="proof-avatars"><i>A</i><i>M</i><i>J</i></span><span>Small acts. <strong>Real impact.</strong></span></div>
        </div>
        <div className="market-hero-visual">
          <div className="hero-sun" />
          <div className="hero-garden"><span>✿</span><span>♧</span><span>❋</span><span>♧</span></div>
          <div className="hero-art-caption"><span>✦</span><div><strong>Good grows here</strong><small>One thoughtful gift at a time</small></div></div>
        </div>
        <div className="market-hero-foot">01 / 03 <span /> MORE THAN A DONATION. A PROMISE KEPT.</div>
      </section>

      <section className="market-stats">
        <div><strong>{campaigns.length}</strong><span>causes to explore</span></div>
        <div><strong>{new Set(campaigns.filter((item) => item.organization.verified).map((item) => item.organization.id)).size}</strong><span>verified organizations</span></div>
        <div><strong>{money(campaigns.reduce((sum, item) => sum + item.goalAmountCents, 0))}</strong><span>in community goals</span></div>
        <div><strong>✓ Ledger verified</strong><span>Every gift, accounted for</span></div>
      </section>

      <section className="discover-section" id="campaigns">
        <div className="section-heading">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> GOOD WORK, HAPPENING NOW</div>
            <h2>Find the good you want to grow.</h2>
            <p>Every campaign is connected to a real organization, real milestones, and a transparent ledger.</p>
          </div>
          <div className="campaign-count"><span>{visibleCampaigns.length.toString().padStart(2, "0")}</span> campaigns</div>
        </div>

        <div className="market-filters">
          <label className="search-field"><span aria-hidden="true">⌕</span>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search causes, organizations, places…" aria-label="Search campaigns" />
          </label>
          <label className="select-filter"><span>Cause</span><select value={cause} onChange={(event) => setCause(event.target.value)}>{causes.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label className="select-filter"><span>Location</span><select value={location} onChange={(event) => setLocation(event.target.value)}>{locations.map((item) => <option key={item}>{item}</option>)}</select></label>
          <span className="rank-note">Ranked by trust score ↓</span>
        </div>

        {campaignsQuery.isPending ? (
          <div className="campaign-grid">{[1, 2, 3].map((item) => <div className="campaign-skeleton" key={item}><div /><span /><span /></div>)}</div>
        ) : campaignsQuery.isError ? (
          <div className="empty-state"><h3>Campaigns couldn’t load.</h3><p>{campaignsQuery.error.message}</p><button className="button button--dark" onClick={() => void campaignsQuery.refetch()}>Try again</button></div>
        ) : visibleCampaigns.length === 0 ? (
          <div className="empty-state"><h3>No matching campaigns.</h3><p>Try a different search or remove a filter.</p><button className="button button--outline" onClick={() => { setSearch(""); setCause("All causes"); setLocation("All locations"); }}>Clear filters</button></div>
        ) : (
          <div className="campaign-grid">
            {visibleCampaigns.map((campaign) => {
              const score = campaign.organization.trustScore;
              const gap = campaign.raisedAmountCents === undefined
                ? null
                : Math.max(0, campaign.goalAmountCents - campaign.raisedAmountCents);
              return (
                <article className="campaign-card" key={campaign.id}>
                  <Link className={`campaign-artwork trust-artwork ${score >= 70 ? "campaign-artwork--healthy" : "campaign-artwork--wilted"}`} to={`/campaigns/${campaign.id}`} aria-label={`View ${campaign.title}, trust score ${score}`}>
                    <span className="artwork-label">{score >= 70 ? "Thriving · " : "Needs care · "}{score} trust</span>
                    <PlantArtwork trustScore={score} />
                    <span className="artwork-shape artwork-shape--one" /><span className="artwork-shape artwork-shape--two" />
                    <span className="artwork-corner">→</span>
                  </Link>
                  <div className="campaign-card-body">
                    <div className="organization-line"><span className="org-avatar">{campaign.organization.name[0]}</span><span>{campaign.organization.name}</span>{campaign.organization.verified && <span className="verified-check" title="Verified">✓</span>}<span className="card-trust-score">{score}</span></div>
                    <Link className="campaign-title" to={`/campaigns/${campaign.id}`}>{campaign.title}</Link>
                    <p className="campaign-description">{campaign.organization.cause} <span>·</span> {campaign.organization.location}</p>
                    <div className="campaign-card-bottom campaign-card-bottom--gap"><span className="campaign-goal-label">FUNDING GAP</span><strong>{gap === null ? "Not reported" : money(gap)}</strong><span className="campaign-milestones">{campaign._count.milestones} milestones · goal {money(campaign.goalAmountCents)}</span></div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="routing-panel">
        <p className="sr-only">Recommendations consider campaign trust scores and remaining funding goals.</p>
        <div className="routing-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> YOUR GIVING, THOUGHTFULLY ROUTED</div>
          <h2>Not sure where to start?</h2>
          <p>Tell us what matters to you. We’ll suggest a transparent split across high-trust campaigns with meaningful funding gaps.</p>
          <label className="routing-field"><span>Your giving goal</span><input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="e.g. support rural education" /></label>
          <div className="routing-chips">
            {["Clean Water", "Rural Education", "Healthcare", "Environment"].map((chip) => (
              <button
                type="button"
                key={chip}
                className="chip-button"
                onClick={() => setGoal(`Support ${chip.toLowerCase()}`)}
              >
                {chip}
              </button>
            ))}
          </div>
          <label className="routing-field"><span>Amount to give</span><div className="routing-amount"><span>$</span><input type="number" min="1" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} /></div></label>
          {routingError && <p className="form-error" role="alert">{routingError}</p>}
          <button className="button button--dark" disabled={suggest.isPending || !goal.trim() || !Number(amount)} onClick={() => suggest.mutate()}>
            {suggest.isPending ? "Finding a thoughtful split…" : "Suggest a split"} <span>→</span>
          </button>
        </div>
        <div className="routing-results">
          {split.length ? (
            <>
              <div className="routing-results-head"><strong>Your suggested split</strong><span>Editable amounts · Total {money(splitTotal)}</span></div>
              {split.map((item, index) => (
                <div className="split-row" key={item.campaignId}>
                  <span className="split-index">0{index + 1}</span>
                  <div className="split-detail"><strong>{item.title}</strong><small>{item.organizationName} · trust {item.trustScore}</small><p>{item.reason}</p></div>
                  <label className="split-amount"><span>$</span><input type="number" min="0" step="1" value={(item.amountCents / 100).toFixed(0)} onChange={(event) => updateSplit(index, event.target.value)} aria-label={`Amount for ${item.title}`} /></label>
                </div>
              ))}
              <button className="button button--dark button--wide" onClick={approveSplit}>Approve this plan <span>→</span></button>
              {routingNotice && <p className="routing-notice" role="status">{routingNotice}</p>}
            </>
          ) : (
            <div className="routing-placeholder"><span>✳</span><strong>A little guidance goes a long way.</strong><p>Your recommendations will appear here with a reason behind every pick.</p><small>TRUST SCORE · FUNDING GAP · YOUR GOAL</small></div>
          )}
        </div>
      </section>

      <section className="how-section" id="how-it-works">
        <div className="how-heading"><div className="eyebrow"><span className="eyebrow-line" /> SIMPLE TO GIVE. EASY TO FOLLOW.</div><h2>From your heart<br />to the heart of it.</h2></div>
        <div className="how-steps">
          <article><span className="step-number">01</span><span className="step-icon">♡</span><h3>Choose a cause</h3><p>Find a campaign and see who’s behind it before you give.</p></article>
          <article><span className="step-number">02</span><span className="step-icon">✦</span><h3>Give with confidence</h3><p>Your secure donation supports a goal with clear milestones.</p></article>
          <article><span className="step-number">03</span><span className="step-icon">◎</span><h3>Follow the impact</h3><p>Review progress, submitted evidence, and a tamper-evident ledger.</p></article>
        </div>
      </section>
      <section className="trust-section" id="trust"><div className="trust-art"><span className="trust-orbit" /><span className="trust-leaf trust-leaf--one">✳</span><span className="trust-leaf trust-leaf--two">❋</span><span className="trust-center">♧</span></div><div className="trust-copy"><div className="eyebrow"><span className="eyebrow-line" /> TRUST ISN’T A PROMISE. IT’S A PRACTICE.</div><h2>Good intentions deserve good transparency.</h2><p>Organizations build a trust profile. Campaigns are organized into milestones. Every key action is added to a verifiable ledger, so your generosity never disappears into a black box.</p><div className="trust-points"><span>✓ Verified organizations</span><span>✓ Milestone-based progress</span><span>✓ Tamper-evident records</span></div></div></section>
      <footer className="footer"><span>impactledger</span><span>More good. Less guesswork.</span><span>© 2026 ImpactLedger</span></footer>
    </>
  );
}
