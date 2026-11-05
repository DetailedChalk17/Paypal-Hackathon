import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { PlantArtwork } from "../components/PlantArtwork";
import { useAuth } from "../auth";

export function TrustProfilePage() {
  const { organizationId = "" } = useParams();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const scoreQuery = useQuery({
    queryKey: ["trust-score", organizationId],
    queryFn: () => api.getTrustScore(organizationId),
    enabled: Boolean(organizationId),
  });
  const recalculate = useMutation({
    mutationFn: () => fetch(`/organizations/${encodeURIComponent(organizationId)}/trust-score/recalculate`, {
      method: "POST",
      credentials: "include",
    }).then(async (response) => {
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
      return payload;
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["trust-score", organizationId] }),
  });

  if (scoreQuery.isPending) return <div className="page-loading"><span className="loading-spinner" /> Loading trust profile…</div>;
  if (scoreQuery.isError || !scoreQuery.data) return <div className="empty-state access-state"><h3>Trust profile unavailable</h3><p>{scoreQuery.error?.message ?? "Organization not found."}</p><Link className="button button--dark" to="/">Back to marketplace</Link></div>;

  const profile = scoreQuery.data;
  const isHealthy = profile.trustScore >= 70;

  return (
    <div className="trust-profile-page">
      <div className="page-back"><Link to="/">← Back to marketplace</Link><span>ORGANIZATION TRUST PROFILE</span></div>
      <section className={`trust-profile-card ${isHealthy ? "campaign-artwork--healthy" : "campaign-artwork--wilted"}`}>
        <div className="trust-profile-art"><PlantArtwork trustScore={profile.trustScore} /></div>
        <div className="trust-profile-copy"><div className="eyebrow"><span className="eyebrow-line" /> A RECORD OF TRANSPARENT WORK</div><h1>{profile.organizationName}</h1><p>{isHealthy ? "A healthy track record of progress and accountability." : "This organization has opportunities to strengthen its verified record."}</p><div className="trust-profile-score"><strong>{profile.trustScore}</strong><span>out of 100 trust score</span></div>{profile.updatedAt && <small>Last recalculated {new Date(profile.updatedAt).toLocaleString()}</small>}</div>
      </section>
      <section className="trust-breakdown-panel"><div className="panel-title-row"><div><div className="eyebrow"><span className="eyebrow-line" /> HOW TRUST IS BUILT</div><h2>Progress, backed by evidence.</h2></div>{user?.role === "reviewer" && <button className="button button--outline" disabled={recalculate.isPending} onClick={() => recalculate.mutate()}>{recalculate.isPending ? "Recalculating…" : "Recalculate score"}</button>}</div>{profile.breakdown ? <pre>{JSON.stringify(profile.breakdown, null, 2)}</pre> : <div className="trust-breakdown-points"><span>✓ Verified evidence and review outcomes</span><span>✓ On-time milestone updates</span><span>✓ Budget compliance</span><span>✓ Completed milestones</span></div>}{recalculate.isError && <p className="form-error" role="alert">{recalculate.error.message}</p>}</section>
    </div>
  );
}
