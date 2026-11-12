import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiUrl, type FailedPayout, type ReviewEvidence } from "../api/client";
import { getEvidencePreview } from "../mock/previews";

export function ReviewerPage() {
  const queryClient = useQueryClient();
  const queueQuery = useQuery({ queryKey: ["review-queue"], queryFn: api.getReviewQueue });
  const payoutsQuery = useQuery({ queryKey: ["payouts", "failed"], queryFn: api.getFailedPayouts });
  const [selected, setSelected] = useState<ReviewEvidence | null>(null);
  const [reason, setReason] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const [payoutNotice, setPayoutNotice] = useState("");
  const evidence = queueQuery.data ?? [];
  const approve = useMutation({
    mutationFn: (id: string) => api.approveEvidence(id),
    onSuccess: async ({ message, payout }) => {
      setPayoutNotice(`${message}. Payout status: ${payout.status}.`);
      setDecisionError("");
      setSelected(null);
      await queryClient.invalidateQueries({ queryKey: ["review-queue"] });
      await queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
    onError: (error) => setDecisionError(error instanceof Error ? error.message : "Unable to approve evidence."),
  });
  const reject = useMutation({
    mutationFn: ({ id, message }: { id: string; message: string }) => api.rejectEvidence(id, message),
    onSuccess: async ({ message }) => {
      setPayoutNotice(message);
      setDecisionError("");
      setSelected(null);
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
    onError: (error) => setDecisionError(error instanceof Error ? error.message : "Unable to reject evidence."),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.retryPayout(id),
    onSuccess: async ({ message, payout, ledgerRecorded }) => {
      setPayoutNotice(`${message}. Status: ${payout.status}${ledgerRecorded ? " · ledger updated" : " · ledger update failed"}.`);
      await queryClient.invalidateQueries({ queryKey: ["payouts", "failed"] });
      await queryClient.invalidateQueries({ queryKey: ["dashboard", "summary"] });
    },
    onError: (error) => setDecisionError(error instanceof Error ? error.message : "Unable to retry payout."),
  });

  function decide(approved: boolean) {
    if (!selected) return;
    if (!window.confirm(approved ? "Approve this evidence and continue to payout?" : "Reject this evidence and return it to the organizer?")) return;
    setDecisionError("");
    if (approved) {
      approve.mutate(selected.id);
    } else {
      if (!reason.trim()) {
        setDecisionError("Add a short reason so the organizer knows what to fix.");
        return;
      }
      reject.mutate({ id: selected.id, message: reason.trim() });
    }
  }

  return (
    <>
      <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> REVIEWER WORKSPACE</div><h1>Review the evidence.</h1><p>Check what was submitted, review the extracted details, and make the next decision visible.</p></div><div className="queue-count"><strong>{evidence.length}</strong><span>items awaiting review</span></div></section>
      {payoutNotice && <div className="payment-notice payment-notice--success" role="status"><span>{payoutNotice}</span><button aria-label="Dismiss" onClick={() => setPayoutNotice("")}>×</button></div>}
      {decisionError && <p className="form-error" role="alert">{decisionError}</p>}
      <section className="review-panel">
        <div className="panel-title-row"><div><h2>Evidence queue</h2><p>Select an item to inspect its receipt and AI findings.</p></div><span className="panel-step">REVIEW · APPROVE · PAY</span></div>
        {queueQuery.isPending ? <div className="page-loading"><span className="loading-spinner" /> Loading evidence queue…</div> : queueQuery.isError ? <div className="empty-state"><h3>Couldn’t load the review queue.</h3><p>{queueQuery.error.message}</p><button className="button button--dark" onClick={() => void queueQuery.refetch()}>Try again</button></div> : evidence.length === 0 ? <div className="empty-state"><span className="empty-icon">✓</span><h3>You’re all caught up.</h3><p>Newly submitted milestone evidence will appear here.</p></div> : (
          <div className="review-grid">
            <table className="review-table">
              <thead>
                <tr><th>Campaign</th><th>Organization</th><th>Milestone</th><th>Submitted</th><th>Decision</th></tr>
              </thead>
              <tbody>
                {evidence.map((item) => (
                  <tr key={item.id} className={selected?.id === item.id ? "review-table-row--selected" : ""}>
                    <td><button className="review-row-select" onClick={() => { setSelected(item); setDecisionError(""); }}>{item.milestone.campaign.title}</button></td>
                    <td>{item.milestone.campaign.organization.name}</td>
                    <td>{item.milestone.title}</td>
                    <td>{item.submittedAt ? new Date(item.submittedAt).toLocaleDateString() : "—"}</td>
                    <td className="review-pending-cell">{item.reviewerDecision}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {selected && (
        <section className="review-detail-panel">
          <div className="review-detail-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> EVIDENCE REVIEW</div><h2>{selected.milestone.title}</h2><p>{selected.milestone.campaign.title} · {selected.milestone.campaign.organization.name}</p></div><button className="button button--outline button--small" onClick={() => setSelected(null)}>Close</button></div>
          <div className="review-detail-grid">
            <div className="receipt-preview">
              {selected.file.toLowerCase().endsWith(".pdf")
                ? <iframe src={getEvidencePreview(selected.id) ?? apiUrl(`/evidence-files/${encodeURIComponent(selected.id)}`)} title={`Receipt preview: ${selected.file}`} />
                : <img src={getEvidencePreview(selected.id) ?? apiUrl(`/evidence-files/${encodeURIComponent(selected.id)}`)} alt={`Receipt preview: ${selected.file}`} />}
              <span>{selected.file}</span>
            </div>
            <div className="extracted-panel">
              <div><strong>Extracted fields</strong><small>AI checked · read-only</small></div>
              {Object.entries(selected.extractedFields).map(([key, value]) => <p className="extracted-field" key={key}><span>{key.replaceAll("_", " ")}</span><strong>{String(value)}</strong></p>)}
              <div className="findings-panel"><strong>AI findings</strong><pre>{JSON.stringify(selected.aiFindings, null, 2)}</pre></div>
              <label className="form-field"><span>Reason for rejection</span><textarea rows={2} placeholder="Tell the organizer what needs attention…" value={reason} onChange={(event) => setReason(event.target.value)} /></label>
              <div className="review-actions">
                <button className="button button--reject" disabled={reject.isPending || approve.isPending} onClick={() => decide(false)}>{reject.isPending ? "Rejecting…" : "Reject with reason"}</button>
                <button className="button button--dark" disabled={reject.isPending || approve.isPending} onClick={() => decide(true)}>{approve.isPending ? "Approving…" : "Approve & pay"} <span>→</span></button>
              </div>
              {approve.isError && <p className="form-error" role="alert">{approve.error.message}</p>}
              {reject.isError && <p className="form-error" role="alert">{reject.error.message}</p>}
            </div>
          </div>
        </section>
      )}
      <section className="failed-payout-panel">
        <div className="panel-title-row"><div><div className="eyebrow"><span className="eyebrow-line" /> PAYMENT FOLLOW-UP</div><h2>Failed payouts</h2><p>Retry a payout after checking the milestone and organization.</p></div><span className="queue-count"><strong>{payoutsQuery.data?.length ?? "—"}</strong><span>to retry</span></span></div>
        {payoutsQuery.isPending ? <div className="page-loading"><span className="loading-spinner" /> Loading failed payouts…</div> : payoutsQuery.isError ? <p className="form-error" role="alert">{payoutsQuery.error.message}</p> : (payoutsQuery.data ?? []).length === 0 ? <p className="no-milestones">No failed payouts. Everything is up to date.</p> : (
          <div className="failed-payout-list">
            {(payoutsQuery.data ?? []).map((payout: FailedPayout) => (
              <article className="failed-payout-row" key={payout.id}>
                <div className="failed-payout-main">
                  <span className="flag-severity flag-severity--high" />
                  <div className="failed-payout-details">
                    <strong>{payout.milestone.title}</strong>
                    <small>{payout.milestone.campaign.title} · {payout.milestone.campaign.organization.name}</small>
                  </div>
                </div>
                <div className="failed-payout-meta">
                  <span className="failed-payout-amount">{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(payout.amountCents / 100)}</span>
                  <span className="status-chip status-chip--rejected">{payout.status}</span>
                  <button className="button button--outline button--small" disabled={retry.isPending} onClick={() => retry.mutate(payout.id)}>{retry.isPending && retry.variables === payout.id ? "Retrying…" : "Retry payout"}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
