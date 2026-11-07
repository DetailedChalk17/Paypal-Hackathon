import { z } from "zod";
import {
  ImpactFactsSchema,
  ImpactUpdateSchema,
  type AiResult,
  type ImpactFacts,
  type ImpactUpdate,
} from "@your-project/shared";
import { callModel, type CallModelOptions } from "./callModel";
import { allowedNumbers, citesOnlyAllowedNumbers, formatDollars } from "./grounding";
import { validated } from "./validated";

const ModelUpdateSchema = z.object({ headline: z.string(), body: z.string() });

export const IMPACT_SYSTEM_PROMPT = `You write a short impact update for donors of a charity campaign.
Use only the facts given. Every number you write must appear in the facts exactly as written there; do not calculate totals, percentages or new figures.
Do not claim anything the facts do not show. Say which milestones are verified (paid) and which are still pending.
headline: under 12 words. body: 2 to 4 sentences, warm and plain.`;

// Optional feature (A9). Real figures only: any number the model writes that is
// not in the facts makes the whole update fall back to a code-written template.
export async function draftImpactUpdate(
  facts: ImpactFacts,
  options: CallModelOptions = {}
): Promise<AiResult<ImpactUpdate>> {
  const parsed = ImpactFactsSchema.safeParse(facts);
  if (!parsed.success) return { ok: false, reason: "invalid_output" };
  const f = parsed.data;

  const factLines = describe(f);
  const prompt = `Facts:\n${factLines.join("\n")}`;
  const result = await callModel({ schema: ModelUpdateSchema, system: IMPACT_SYSTEM_PROMPT, prompt }, options);

  if (result.ok) {
    const allowed = allowedNumbers(prompt);
    const { headline, body } = result.data;
    if (headline.trim() && body.trim() && citesOnlyAllowedNumbers(`${headline} ${body}`, allowed)) {
      return validated(ImpactUpdateSchema, { headline: headline.trim(), body: body.trim(), source: "model" });
    }
  }
  return validated(ImpactUpdateSchema, { ...template(f), source: "template" });
}

function describe(f: ImpactFacts): string[] {
  const paid = f.milestones.filter((m) => m.status === "paid");
  return [
    `Campaign: ${f.campaignTitle} by ${f.organizationName}.`,
    `Raised ${formatDollars(f.raisedCents)} of a ${formatDollars(f.goalCents)} goal from ${f.donorCount} donors.`,
    `Milestones verified and paid: ${paid.length} of ${f.milestones.length}.`,
    ...f.milestones.map(
      (m) => `Milestone "${m.title}": ${m.status.replace("_", " ")}; budget ${formatDollars(m.budgetCents)}; paid out ${formatDollars(m.paidCents)}.`
    ),
  ];
}

function template(f: ImpactFacts): { headline: string; body: string } {
  const paid = f.milestones.filter((m) => m.status === "paid");
  const pending = f.milestones.filter((m) => m.status !== "paid");
  const body = [
    `${f.organizationName} has raised ${formatDollars(f.raisedCents)} of its ${formatDollars(f.goalCents)} goal from ${f.donorCount} donors.`,
    paid.length
      ? `Verified and paid: ${paid.map((m) => `${m.title} (${formatDollars(m.paidCents)})`).join(", ")}.`
      : "No milestone has been verified and paid yet.",
    pending.length ? `Still pending: ${pending.map((m) => m.title).join(", ")}.` : "",
  ].filter(Boolean);
  return { headline: `Update on ${f.campaignTitle}`, body: body.join(" ") };
}
