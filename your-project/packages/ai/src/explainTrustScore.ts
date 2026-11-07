import { z } from "zod";
import {
  TrustBreakdownSchema,
  TrustExplanationSchema,
  type AiResult,
  type ExplainTrustScoreInput,
  type TrustComponent,
  type TrustExplanation,
} from "@your-project/shared";
import { callModel, type CallModelOptions } from "./callModel";
import { allowedNumbers, citesOnlyAllowedNumbers } from "./grounding";
import { validated } from "./validated";

// A component earning at least this share of its points is a strength.
export const STRENGTH_THRESHOLD = 0.75;

// Plain-language descriptions of the API's trust-score components.
const LABELS: Record<string, string> = {
  approvedWithEvidence: "milestones approved by a reviewer with evidence",
  onTimeUpdates: "milestones with evidence submitted by the due date",
  budgetCompliance: "campaigns whose milestone budgets fit within the campaign goal",
  completedMilestones: "milestones completed and paid out",
};

const ModelExplanationSchema = z.object({
  items: z.array(z.object({ key: z.string(), text: z.string() })),
});

export const TRUST_SYSTEM_PROMPT = `You explain an organization's trust score to donors in plain language.
You receive scored components, each already labelled as a strength or a weakness, with the facts behind it.
For each component write one short, friendly sentence (under 25 words) that states the fact.
Use only the numbers given in that component's facts or the overall score. Do not calculate new numbers, percentages or rankings.
Do not change whether a component is a strength or a weakness. Return one item per component key.`;

type Item = { key: string; kind: "strength" | "weakness"; fact: string; component: TrustComponent };

export async function explainTrustScore(
  input: ExplainTrustScoreInput,
  options: CallModelOptions = {}
): Promise<AiResult<TrustExplanation>> {
  const parsed = TrustBreakdownSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid_output" };
  const { score, components } = parsed.data;

  // Classification is a rule, so it runs in code.
  const items: Item[] = Object.entries(components)
    .filter(([, c]) => c.applicable && c.weight > 0)
    .map(([key, c]) => ({
      key,
      kind: c.earnedPoints / c.weight >= STRENGTH_THRESHOLD ? "strength" : "weakness",
      fact: factFor(key, c),
      component: c,
    }));

  const texts = new Map(items.map((i) => [i.key, i.fact])); // template wording by default
  let allFromModel = false;

  if (items.length > 0) {
    const prompt =
      `Overall trust score: ${score} out of 100.\n\nComponents:\n` +
      items.map((i) => `- key: ${i.key} | ${i.kind} | facts: ${i.fact}`).join("\n");
    const result = await callModel({ schema: ModelExplanationSchema, system: TRUST_SYSTEM_PROMPT, prompt }, options);

    if (result.ok) {
      let accepted = 0;
      for (const i of items) {
        const text = result.data.items.find((m) => m.key === i.key)?.text.trim();
        const allowed = allowedNumbers(score, i.fact);
        if (text && citesOnlyAllowedNumbers(text, allowed)) {
          texts.set(i.key, text);
          accepted++;
        }
      }
      allFromModel = accepted === items.length;
    }
  }

  const pick = (kind: Item["kind"]) => items.filter((i) => i.kind === kind).map((i) => ({ key: i.key, text: texts.get(i.key)! }));
  return validated(TrustExplanationSchema, {
    strengths: pick("strength"),
    weaknesses: pick("weakness"),
    source: allFromModel ? "model" : "template",
  });
}

function factFor(key: string, c: TrustComponent): string {
  const label = LABELS[key] ?? humanize(key);
  return `${c.numerator} of ${c.denominator} ${label} (${c.earnedPoints} of ${c.weight} points).`;
}

function humanize(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}
