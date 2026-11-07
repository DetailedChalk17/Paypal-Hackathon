import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { PlantArtwork } from "../components/PlantArtwork";
import { useAuth } from "../auth";

const donationOptions = [5, 10, 25];

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

export function CampaignPage() {
  const { campaignId = "" } = useParams();
  const navigate = useNavigate();
  const { user, openSignIn } = useAuth();
  const campaignQuery = useQuery({ queryKey: ["campaign", campaignId], queryFn: () => api.getCampaign(campaignId), enabled: Boolean(campaignId) });
  const campaign = campaignQuery.data;
  const [amount, setAmount] = useState("25");
  const [selected, setSelected] = useState<number | "custom">(25);
  const [donationError, setDonationError] = useState("");
  const donate = useMutation({
    mutationFn: () => api.createDonation(campaignId, Math.round(Number(amount) * 100)),
    onSuccess: (result) => {
      setDonationError("");
      if (result.approvalUrl) {
        window.location.assign(result.approvalUrl);
      } else {
        navigate(`/receipt/${result.donationId}`);
      }
    },
    onError: (error) => setDonationError(error instanceof Error ? error.message : "Unable to start donation."),
  });

  if (campaignQuery.isPending) return <div className="page-loading"><span className="loading-spinner" /> Loading campaign…</div>;
  if (campaignQuery.isError || !campaign) {
    return <div className="empty-state access-state"><h3>Campaign details unavailable</h3><p>{campaignQuery.error?.message ?? "Campaign not found."}</p><Link className="button button--dark" to="/">Back to marketplace</Link></div>;
  }

  const score = campaign.organization.trustScore;
  const progress = campaign.goalAmountCents > 0 ? Math.min(100, Math.round((campaign.raisedAmountCents / campaign.goalAmountCents) * 100)) : 0;
  const milestoneTotal = campaign.milestones.reduce((total, milestone) => total + milestone.budgetAmountCents, 0);

  function makeDonation() {
    if (!user || user.role !== "donor") {
      openSignIn("donor");
      return;
    }
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isSafeInteger(cents) || cents < 100) {
      setDonationError("Enter an amount of at least $1.");
      return;
    }
    setDonationError("");
    donate.mutate();
  }

  return (
    <>
      <div className="page-back"><Link to="/">← Back to marketplace</Link><span>Campaign / {campaign.title}</span></div>
      <section className="campaign-detail-hero">
        <div className={`campaign-detail-art ${score >= 70 ? "campaign-artwork--healthy" : "campaign-artwork--wilted"}`}>
          <span className="artwork-label">{score >= 70 ? "Thriving organization" : "Organization needs care"} · {score}/100</span>
          <PlantArtwork trustScore={score} />
          <span className="artwork-shape artwork-shape--one" /><span className="artwork-shape artwork-shape--two" />
        </div>
        <div className="campaign-detail-copy">
          <div className="organization-line"><span className="org-avatar">{campaign.organization.name[0]}</span><span>{campaign.organization.name}</span>{campaign.organization.verified && <span className="verified-check">✓</span>}</div>
          <div className="eyebrow"><span className="eyebrow-line" /> {campaign.organization.cause.toUpperCase()} · {campaign.organization.location.toUpperCase()}</div>
          <h1>{campaign.title}</h1>
          <p>Back a clear, milestone-based plan from {campaign.organization.name}. Track the work as it moves from planning to delivery.</p>
          <div className="trust-summary"><span className="trust-score-large">{score}</span><div><strong>Organization trust score</strong><small>{score >= 70 ? "A healthy track record of transparent progress." : "This organization could use more verified progress."}</small></div><Link to={`/organizations/${campaign.organization.id}/trust`}>See profile →</Link></div>
        </div>
      </section>

      <div className="campaign-detail-columns">
        <div className="campaign-detail-main">
          <section className="detail-panel">
            <div className="section-heading section-heading--compact"><div><div className="eyebrow"><span className="eyebrow-line" /> THE PLAN</div><h2>Progress, step by step.</h2></div><span className="detail-count">{campaign.milestones.length} milestones</span></div>
            <div className="progress-label"><span>Raised so far</span><strong>{money(campaign.raisedAmountCents)}</strong></div>
            <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
            <div className="progress-foot"><span>{progress}% funded</span><span>Goal {money(campaign.goalAmountCents)}</span></div>
            <div className="milestone-list">
              {campaign.milestones.map((milestone, index) => (
                <article className="milestone-card" key={milestone.id}>
                  <span className={`milestone-step milestone-step--${milestone.status}`}>{String(index + 1).padStart(2, "0")}</span>
                  <div className="milestone-info"><strong>{milestone.title}</strong><small>{milestone.dueDate ? new Date(milestone.dueDate).toLocaleDateString() : "Timeline to be confirmed"}</small></div>
                  <span className={`status-chip status-chip--${milestone.status}`}>{milestone.status.replace("_", " ")}</span>
                  <strong className="milestone-budget">{money(milestone.budgetAmountCents)}</strong>
                </article>
              ))}
              {campaign.milestones.length === 0 && <p className="no-milestones">The organizer is preparing campaign milestones.</p>}
            </div>
            {milestoneTotal > campaign.goalAmountCents && <p className="form-error">The current milestone allocation exceeds the campaign goal.</p>}
          </section>
          <section className="detail-panel"><div className="eyebrow"><span className="eyebrow-line" /> BUILT FOR ACCOUNTABILITY</div><h2>Follow the whole story.</h2><p className="detail-description">Donations are recorded in a tamper-evident ledger. As milestones progress, submitted evidence and review decisions become part of the campaign’s transparent record.</p><Link className="button button--outline" to="/#trust">How transparency works →</Link></section>
        </div>

        <aside className="donation-card">
          <span className="modal-kicker">MAKE A DIFFERENCE</span>
          <h2>Your support moves this forward.</h2>
          <p>Choose an amount. Every gift is recorded and allocated across the campaign’s milestones.</p>
          <div className="amount-options">
            {donationOptions.map((option) => <button key={option} className={selected === option ? "amount-option amount-option--active" : "amount-option"} onClick={() => { setSelected(option); setAmount(String(option)); }}>{money(option * 100)}</button>)}
            <button className={selected === "custom" ? "amount-option amount-option--active" : "amount-option"} onClick={() => setSelected("custom")}>Custom</button>
          </div>
          {selected === "custom" && <label className="custom-amount"><span>Donation amount</span><div className="amount-field"><span>$</span><input type="number" min="1" step="1" value={amount} onChange={(event) => setAmount(event.target.value)} /></div></label>}
          {donationError && <p className="form-error" role="alert">{donationError}</p>}
          <button className="button button--dark button--wide donate-button" disabled={donate.isPending || campaign.status !== "active"} onClick={makeDonation}>
            {donate.isPending ? "Preparing donation…" : selected === "custom" ? `Give ${money(Math.round(Number(amount || 0) * 100))}` : `Give ${money(Number(amount) * 100)}`} <span>→</span>
          </button>
          <p className="donation-secure">♧ {import.meta.env.VITE_API_MODE === "real" ? "Secure checkout powered by PayPal" : "Demo payment · no real charge"}</p>
          <div className="donation-card-note"><span>✓</span><p><strong>Trust score {score}</strong><br />{score >= 70 ? "This organization has a healthy transparency record." : "See the trust profile before deciding to give."}</p></div>
          <div className="receipt-link-note">After donating, you’ll get an Impact Receipt with a milestone allocation and ledger reference.</div>
        </aside>
      </div>
    </>
  );
}
