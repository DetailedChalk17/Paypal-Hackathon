import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import {
  CreateCampaignInputSchema,
  CreateMilestoneInputSchema,
} from "@your-project/shared";
import { api, type Campaign, type CampaignDetails, type Evidence } from "../api/client";
import { saveEvidencePreview } from "../mock/previews";

const CampaignSetupSchema = CreateCampaignInputSchema.extend({
  payoutEmail: z.string().email("Enter a valid payout email address."),
  milestones: z.array(CreateMilestoneInputSchema.extend({
    dueDate: z.string().optional(),
  })).min(1, "Add at least one milestone."),
});

type CampaignSetupValues = z.infer<typeof CampaignSetupSchema>;

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

function CampaignForm({ campaigns }: { campaigns: Campaign[] }) {
  const queryClient = useQueryClient();
  const organizations = useMemo(() => {
    const seen = new Set<string>();
    return campaigns.map((campaign) => campaign.organization).filter((organization) => {
      if (seen.has(organization.id)) return false;
      seen.add(organization.id);
      return true;
    });
  }, [campaigns]);
  const [submissionError, setSubmissionError] = useState("");
  const [createdCampaign, setCreatedCampaign] = useState<{ id: string; title: string } | null>(null);
  const form = useForm<CampaignSetupValues>({
    resolver: zodResolver(CampaignSetupSchema),
    defaultValues: {
      organizationId: organizations[0]?.id ?? "",
      title: "",
      goalAmountCents: 500000,
      payoutEmail: organizations[0]?.payoutEmail ?? "",
      milestones: [
        { title: "Planning and procurement", budgetAmountCents: 200000, dueDate: "" },
        { title: "Implementation and delivery", budgetAmountCents: 300000, dueDate: "" },
      ],
    },
  });
  const milestones = useFieldArray({ control: form.control, name: "milestones" });
  const watched = form.watch();
  const selectedOrganizationId = form.watch("organizationId");
  useEffect(() => {
    if (!selectedOrganizationId && organizations[0]) {
      form.setValue("organizationId", organizations[0].id);
      form.setValue("payoutEmail", organizations[0].payoutEmail ?? "");
      return;
    }
    const organization = organizations.find((item) => item.id === selectedOrganizationId);
    if (organization) form.setValue("payoutEmail", organization.payoutEmail ?? "");
  }, [form, organizations, selectedOrganizationId]);
  const milestoneTotal = (watched.milestones ?? []).reduce((total, item) => total + (Number(item.budgetAmountCents) || 0), 0);
  const goal = Number(watched.goalAmountCents) || 0;
  const create = useMutation({
    mutationFn: async (values: CampaignSetupValues) => {
      const campaign = await api.createCampaign({
        organizationId: values.organizationId,
        title: values.title,
        goalAmountCents: values.goalAmountCents,
      });
      try {
        await api.updatePayoutEmail(values.organizationId, values.payoutEmail);
        for (const milestone of values.milestones) {
          await api.createMilestone(campaign.id, {
            title: milestone.title,
            budgetAmountCents: milestone.budgetAmountCents,
            ...(milestone.dueDate ? { dueDate: new Date(`${milestone.dueDate}T00:00:00.000Z`).toISOString() } : {}),
          });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : "The follow-up request failed.";
        throw new Error(`Campaign “${campaign.title}” was created, but its payout email or milestone setup did not finish: ${detail}`);
      }
      return campaign;
    },
    onSuccess: async (campaign) => {
      await queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      setSubmissionError("");
      setCreatedCampaign({ id: campaign.id, title: campaign.title });
      form.reset({
        organizationId: organizations[0]?.id ?? "",
        title: "",
        goalAmountCents: 500000,
        payoutEmail: organizations[0]?.payoutEmail ?? "",
        milestones: [{ title: "Planning and procurement", budgetAmountCents: 200000, dueDate: "" }],
      });
    },
    onError: (error) => {
      setSubmissionError(error instanceof Error ? error.message : "Campaign creation failed.");
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });

  function submit(values: CampaignSetupValues) {
    setSubmissionError("");
    setCreatedCampaign(null);
    if (milestoneTotal > goal) {
      setSubmissionError("Milestone budgets cannot exceed the campaign goal.");
      return;
    }
    create.mutate(values);
  }

  return (
    <section className="organizer-form-panel">
      <div className="panel-title-row"><div><div className="eyebrow"><span className="eyebrow-line" /> BUILD A TRANSPARENT PLAN</div><h2>Create a campaign</h2></div><span className="panel-step">01 / SETUP</span></div>
      {organizations.length === 0 && <p className="inline-alert inline-alert--error">An organization is needed before campaigns can be created.</p>}
      <form className="campaign-setup-form" onSubmit={form.handleSubmit(submit)}>
        <label className="form-field"><span>Organization</span><select {...form.register("organizationId")} disabled={!organizations.length}>{organizations.map((organization) => <option value={organization.id} key={organization.id}>{organization.name} · trust {organization.trustScore}</option>)}</select>{form.formState.errors.organizationId && <small className="form-error">{form.formState.errors.organizationId.message}</small>}</label>
        <label className="form-field"><span>Campaign title</span><input placeholder="What are you working toward?" {...form.register("title")} />{form.formState.errors.title && <small className="form-error">{form.formState.errors.title.message}</small>}</label>
        <div className="form-two-col">
          <label className="form-field"><span>Fundraising goal (USD)</span><div className="amount-field"><span>$</span><Controller control={form.control} name="goalAmountCents" render={({ field }) => <input name={field.name} ref={field.ref} type="number" step="0.01" min="0.01" onBlur={field.onBlur} onChange={(event) => field.onChange(Math.round(Number(event.target.value) * 100))} value={(Number(field.value) || 0) / 100} />}/></div>{form.formState.errors.goalAmountCents && <small className="form-error">{form.formState.errors.goalAmountCents.message}</small>}</label>
          <label className="form-field"><span>Payout email</span><input type="email" placeholder="payments@example.org" {...form.register("payoutEmail")} />{form.formState.errors.payoutEmail && <small className="form-error">{form.formState.errors.payoutEmail.message}</small>}</label>
        </div>
        <div className="milestone-builder">
          <div className="milestone-builder-head"><div><strong>Milestones</strong><small>Break the goal into verifiable steps.</small></div><span className={milestoneTotal > goal ? "budget-total budget-total--over" : "budget-total"}>{money(milestoneTotal)} / {money(goal)}</span></div>
          {milestones.fields.map((field, index) => (
            <div className="milestone-form-row" key={field.id}>
              <span className="milestone-form-index">{String(index + 1).padStart(2, "0")}</span>
              <label className="form-field"><span>Milestone</span><input placeholder="Milestone title" {...form.register(`milestones.${index}.title`)} />{form.formState.errors.milestones?.[index]?.title && <small className="form-error">{form.formState.errors.milestones[index]?.title?.message}</small>}</label>
              <label className="form-field"><span>Budget (USD)</span><div className="amount-field"><span>$</span><Controller control={form.control} name={`milestones.${index}.budgetAmountCents`} render={({ field }) => <input name={field.name} ref={field.ref} type="number" step="0.01" min="0.01" onBlur={field.onBlur} onChange={(event) => field.onChange(Math.round(Number(event.target.value) * 100))} value={(Number(field.value) || 0) / 100} />}/></div>{form.formState.errors.milestones?.[index]?.budgetAmountCents && <small className="form-error">{form.formState.errors.milestones[index]?.budgetAmountCents?.message}</small>}</label>
              <label className="form-field"><span>Due date</span><input type="date" {...form.register(`milestones.${index}.dueDate`)} /></label>
              {milestones.fields.length > 1 && <button className="remove-row-button" type="button" aria-label={`Remove milestone ${index + 1}`} onClick={() => milestones.remove(index)}>×</button>}
            </div>
          ))}
          {form.formState.errors.milestones?.root && <p className="form-error">{form.formState.errors.milestones.root.message}</p>}
          <button type="button" className="add-milestone-button" onClick={() => milestones.append({ title: "", budgetAmountCents: 0, dueDate: "" })}>+ Add another milestone</button>
        </div>
        {milestoneTotal > goal && <p className="form-error" role="alert">Milestone total exceeds the campaign goal by {money(milestoneTotal - goal)}.</p>}
        {submissionError && <p className="form-error" role="alert">{submissionError}</p>}
        {createdCampaign && <p className="form-success" role="status">Campaign created. <Link to={`/campaigns/${createdCampaign.id}`}>View {createdCampaign.title} →</Link></p>}
        <button className="button button--dark" type="submit" disabled={create.isPending || !organizations.length || milestoneTotal > goal}>
          {create.isPending ? "Creating your campaign…" : "Create campaign"} <span>→</span>
        </button>
        <p className="form-note">The payout email is captured in this setup form. Campaign and milestone details are saved through the organizer API.</p>
      </form>
    </section>
  );
}

function MilestoneEvidence({ campaign, onUploaded }: { campaign: CampaignDetails; onUploaded: () => void }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Record<string, Evidence>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const upload = useMutation({
    mutationFn: ({ milestoneId, file }: { milestoneId: string; file: File }) => api.uploadEvidence(milestoneId, file),
    onSuccess: ({ evidence }, { file }) => {
      if (import.meta.env.VITE_API_MODE !== "real") {
        saveEvidencePreview(evidence.id, file);
      }
      setUploads((current) => ({ ...current, [evidence.milestoneId]: evidence }));
      setErrors((current) => ({ ...current, [evidence.milestoneId]: "" }));
      onUploaded();
    },
  });

  function chooseFile(milestoneId: string, file?: File) {
    if (!file) return;
    if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type)) {
      setErrors((current) => ({ ...current, [milestoneId]: "Choose a JPG, PNG, or PDF file." }));
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setErrors((current) => ({ ...current, [milestoneId]: "File size cannot exceed 5 MB." }));
      return;
    }
    setErrors((current) => ({ ...current, [milestoneId]: "" }));
    upload.mutate({ milestoneId, file });
  }

  return (
    <div className="evidence-worklist">
      {campaign.milestones.map((milestone) => {
        const evidence = uploads[milestone.id];
        const submitted = evidence || milestone.status !== "open";
        const status: string = evidence?.reviewerDecision ?? (milestone.status === "paid" ? "paid" : milestone.status === "approved" ? "approved" : submitted ? "submitted" : "not submitted");
        return (
          <article className="evidence-milestone" key={milestone.id}>
            <div className="evidence-milestone-heading"><div><strong>{milestone.title}</strong><small>{money(milestone.budgetAmountCents)} allocated</small></div><span className={`status-chip status-chip--${milestone.status}`}>{status}</span></div>
            <div className="status-stepper">
              {["Submitted", "AI checked", "Reviewed", "Paid"].map((step, index) => <span className={`${submitted && index < 2 ? "step-done" : ""} ${status === "approved" && index > 1 || status === "paid" && index > 1 ? "step-done" : ""}`} key={step}><i>{submitted && index === 0 ? "✓" : index + 1}</i>{step}</span>)}
            </div>
            {evidence && <div className="ai-results"><strong>AI extraction</strong><span>File: {evidence.file}</span><span>{JSON.stringify(evidence.extractedFields)}</span><span>{JSON.stringify(evidence.aiFindings)}</span></div>}
            {milestone.status === "open" && (
              <label
                className={`upload-dropzone ${dragging === milestone.id ? "upload-dropzone--active" : ""}`}
                onDragOver={(event) => { event.preventDefault(); setDragging(milestone.id); }}
                onDragLeave={() => setDragging(null)}
                onDrop={(event) => { event.preventDefault(); setDragging(null); chooseFile(milestone.id, event.dataTransfer.files[0]); }}
              >
                <input type="file" accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf" onChange={(event) => chooseFile(milestone.id, event.target.files?.[0])} />
                <span>↑</span><strong>{upload.isPending ? "Uploading and checking evidence…" : "Drop a receipt here or browse"}</strong><small>JPG, PNG, or PDF · max 5 MB</small>
              </label>
            )}
            {errors[milestone.id] && <p className="form-error" role="alert">{errors[milestone.id]}</p>}
            {upload.isError && upload.variables?.milestoneId === milestone.id && <p className="form-error" role="alert">{upload.error.message}</p>}
          </article>
        );
      })}
    </div>
  );
}

export function OrganizerPage() {
  const queryClient = useQueryClient();
  const campaignsQuery = useQuery({ queryKey: ["campaigns"], queryFn: api.getCampaigns });
  const campaigns = campaignsQuery.data ?? [];
  const [selectedId, setSelectedId] = useState("");
  const selectedCampaignId = selectedId || campaigns[0]?.id || "";
  const detailQuery = useQuery({
    queryKey: ["campaign", selectedCampaignId],
    queryFn: () => api.getCampaign(selectedCampaignId),
    enabled: Boolean(selectedCampaignId),
  });

  return (
    <>
      <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> ORGANIZER WORKSPACE</div><h1>Make good work happen.</h1><p>Create a campaign, plan the milestones, and keep the evidence close to the work.</p></div><Link className="button button--outline" to="/">View marketplace ↗</Link></section>
      <div className="organizer-grid">
        <CampaignForm campaigns={campaigns} />
        <section className="organizer-form-panel organizer-campaign-list">
          <div className="panel-title-row"><div><div className="eyebrow"><span className="eyebrow-line" /> KEEP PROGRESS VISIBLE</div><h2>Campaign evidence</h2></div><span className="campaign-count"><span>{campaigns.length}</span> campaigns</span></div>
          {campaignsQuery.isPending ? <div className="page-loading"><span className="loading-spinner" /> Loading campaigns…</div> : campaignsQuery.isError ? <p className="form-error">{campaignsQuery.error.message}</p> : (
            <>
              <label className="form-field"><span>Choose a campaign</span><select value={selectedCampaignId} onChange={(event) => setSelectedId(event.target.value)}>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.title}</option>)}</select></label>
              {detailQuery.isPending ? <div className="page-loading"><span className="loading-spinner" /> Loading milestones…</div> : detailQuery.isError ? <p className="form-error">{detailQuery.error.message}</p> : detailQuery.data ? <MilestoneEvidence campaign={detailQuery.data} onUploaded={() => {
                void queryClient.invalidateQueries({ queryKey: ["campaign", selectedCampaignId] });
                void queryClient.invalidateQueries({ queryKey: ["review-queue"] });
              }} /> : null}
            </>
          )}
        </section>
      </div>
    </>
  );
}
