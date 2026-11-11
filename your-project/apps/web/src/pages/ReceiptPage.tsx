import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth";

function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100);
}

function amountValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function ReceiptPage() {
  const { donationId = "" } = useParams();
  const { user, openSignIn } = useAuth();
  const [copyNotice, setCopyNotice] = useState("");
  const receiptQuery = useQuery({ queryKey: ["receipt", donationId], queryFn: () => api.getReceipt(donationId), enabled: Boolean(donationId) });
  const verify = useMutation({ mutationFn: api.verifyLedger });
  const receipt = receiptQuery.data;
  const allocation = receipt?.allocation;
  const milestoneAllocations = allocation?.allocations ?? allocation?.milestones ?? [];
  const verifiedCents = amountValue(allocation?.verifiedAmountCents);
  const pendingCents = amountValue(allocation?.pendingAmountCents);

  async function copyHash() {
    const hash = receipt?.ledger.latestHash;
    if (!hash) return;
    try {
      await navigator.clipboard.writeText(hash);
      setCopyNotice("Ledger hash copied.");
    } catch (error) {
      setCopyNotice(error instanceof Error ? `Could not copy ledger hash: ${error.message}` : "Could not copy ledger hash.");
    }
  }

  if (!user) return <div className="empty-state access-state"><span className="empty-icon">♡</span><h3>Sign in to view this receipt.</h3><p>Receipts are private to the donor, campaign organizer, and reviewers.</p><button className="button button--dark" onClick={() => openSignIn("donor")}>Sign in as supporter</button></div>;
  if (receiptQuery.isPending) return <div className="page-loading"><span className="loading-spinner" /> Preparing your Impact Receipt…</div>;
  if (receiptQuery.isError || !receipt) {
    return <div className="empty-state access-state"><span className="empty-icon">♡</span><h3>Receipt unavailable</h3><p>{receiptQuery.error?.message ?? "We couldn’t find this donation."}</p><Link className="button button--dark" to="/">Explore campaigns</Link></div>;
  }

  const totalAmount = receipt.donation.amountCents;
  const hasAllocation = verifiedCents > 0 || pendingCents > 0;

  return (
    <div className="receipt-page">
      <div className="page-back"><Link to={`/campaigns/${receipt.campaign.id}`}>← Back to campaign</Link><span>IMPACT RECEIPT / {receipt.donation.id.slice(0, 8).toUpperCase()}</span></div>
      <article className="receipt-card">
        <header className="receipt-header"><span className="receipt-logo">✳</span><div><div className="eyebrow"><span className="eyebrow-line" /> A RECORD OF GOOD</div><h1>Your Impact Receipt</h1></div><span className="receipt-paid">✓ {receipt.donation.status}</span></header>
        <div className="receipt-amount"><span>Your gift</span><strong>{money(totalAmount, receipt.donation.currency)}</strong><small>Thank you, {receipt.donor.name}.</small></div>
        <div className="receipt-campaign"><div><span>CAMPAIGN</span><Link to={`/campaigns/${receipt.campaign.id}`}>{receipt.campaign.title}</Link><small>{receipt.organization.name} · Trust score {receipt.organization.trustScore}</small></div><span className="receipt-check">✓</span></div>

        <section className="receipt-section">
          <div className="receipt-section-head"><div><div className="eyebrow"><span className="eyebrow-line" /> WHERE YOUR GIFT GOES</div><h2>Milestone allocation</h2></div><span>{milestoneAllocations.length} milestones</span></div>
          {milestoneAllocations.map((item, index) => {
            const cents = amountValue(item.allocatedAmountCents ?? ("amountCents" in item ? item.amountCents : undefined));
            const status = ("verificationStatus" in item ? item.verificationStatus : undefined) ?? item.status ?? "pending";
            return (
              <div className="receipt-allocation-row" key={item.milestoneId ?? `${item.title}-${index}`}>
                <span className={`allocation-marker allocation-marker--${status}`}>{status === "paid" || status === "approved" ? "✓" : String(index + 1).padStart(2, "0")}</span>
                <div><strong>{item.title}</strong><small className={`status-chip status-chip--${status}`}>{status.replace("_", " ")}</small></div>
                <strong>{money(cents, receipt.donation.currency)}</strong>
                <div className="receipt-row-bar"><span style={{ width: `${totalAmount ? Math.min(100, cents / totalAmount * 100) : 0}%` }} /></div>
              </div>
            );
          })}
          {milestoneAllocations.length === 0 && <p className="no-milestones">Milestone allocation isn’t available for this receipt.</p>}
          <div className="receipt-allocation-totals">
            <span><i className="allocation-legend allocation-legend--verified" /> Verified <strong>{money(verifiedCents, receipt.donation.currency)}</strong></span>
            <span><i className="allocation-legend allocation-legend--pending" /> Pending <strong>{money(hasAllocation ? pendingCents : totalAmount, receipt.donation.currency)}</strong></span>
          </div>
          <p className="receipt-disclaimer">{typeof allocation?.note === "string" ? allocation.note : "Milestone amounts are estimated proportionally from campaign budgets; they do not represent actual PayPal fund segregation."}</p>
        </section>

        <section className="receipt-ledger">
          <div><div className="eyebrow"><span className="eyebrow-line" /> TAMPER-EVIDENT RECORD</div><h2>Ledger verification</h2><p>{receipt.ledger.latestHash ? `Latest record · ${receipt.ledger.createdAt ? new Date(receipt.ledger.createdAt).toLocaleString() : "timestamp unavailable"}` : "No ledger hash is available yet."}</p></div>
          <div className="ledger-hash-row"><code>{receipt.ledger.latestHash ?? "No hash recorded"}</code>{receipt.ledger.latestHash && <button className="button button--outline button--small" onClick={() => void copyHash()}>Copy hash</button>}</div>
          {copyNotice && <p className="form-note" role="status">{copyNotice}</p>}
          <div className="ledger-verify-result">
            {verify.data ? <span className={verify.data.valid ? "verify-good" : "verify-bad"}>{verify.data.valid ? "✓ Ledger chain is valid" : `! Ledger verification failed: ${verify.data.reason ?? "integrity issue detected"}`} · {verify.data.checkedEvents} events checked</span> : <span>Verify the ledger chain against the recorded events.</span>}
            <button className="button button--dark button--small" disabled={verify.isPending} onClick={() => verify.mutate()}>{verify.isPending ? "Verifying…" : "Verify ledger"}</button>
          </div>
          {verify.isError && <p className="form-error" role="alert">{verify.error.message}</p>}
        </section>

        <footer className="receipt-actions">
          <Link className="button button--outline" to={`/trace/${receipt.donation.id}`}>Trace my impact <span>→</span></Link>
          <button className="button button--dark" onClick={() => window.print()}>Print / Save PDF <span>↗</span></button>
        </footer>
        <div className="receipt-footer">IMPACTLEDGER · GENEROSITY, MADE TRANSPARENT</div>
      </article>
    </div>
  );
}
