# @your-project/ai

The AI package for ImpactLedger. It reads receipts, runs **AI-assisted checks** on milestone evidence, explains trust scores, helps donors split a donation and drafts impact updates.

The AI assists and explains. It never moves money, never approves anything and never sees PayPal credentials: every function returns data that code validates and a human acts on. The checks are consistency checks and flags; they cannot prove a document is genuine.

## Setup

In `your-project/.env` (git-ignored, never commit it):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `AI_API_KEY` | yes | | Google AI Studio API key (free tier works) |
| `AI_PROVIDER` | no | `gemini` | Model provider adapter |
| `AI_MODEL` | no | `gemini-3.8-flash` | Model id; set it to the free model AI Studio lists if different |

Without a key nothing crashes: model calls return `api_error`, evidence goes to manual review and the other functions use their code fallbacks.

## Commands (run in `packages/ai`)

| Command | What it does | API calls |
|---|---|---|
| `npm test` | Unit tests with fake models | none |
| `npm run typecheck` | TypeScript check | none |
| `npm run eval -- --mock` | Full eval with a perfect fake model: checks the pipeline and scoring | none |
| `npm run eval` | Full eval against the real model (needs `AI_API_KEY`) | about 40 |
| `npm run test:live` | Quick live extraction check (target 12 of 15) | 15+ |

`npm run eval` prints pass rates for extraction, flags, the prompt-injection receipt, an API outage, trust explanation, routing, request parsing and impact updates, then the model name and every prompt used (for the submission write-up). It writes `eval/results/latest.json` and exits non-zero if a target is missed. Options: `--delay-ms=N` (pause between live calls, default 4500 to stay under free-tier rate limits) and `--only=r01,r16`.

The eval set is `scripts/receipts` (16 synthetic receipts and `expected.json`, see its README).

## Functions

| Function | Model does | Code does | If the model fails |
|---|---|---|---|
| `analyzeEvidenceFile(path, context)` / `analyzeEvidence({ file, ...context })` | see the next two rows | runs extraction then checks; never throws | `status: "needs_manual_review"` with `failureReason` |
| `extractReceipt(file)` | transcribes vendor, date, items and amounts as printed text; reports readability and hidden instructions | file type by magic bytes, 5 MB limit, PDF page 1 to PNG, text to cents, nulls instead of guesses, confidence caps | `{ ok: false, reason }` |
| `checkEvidence(input)` | picks the budget line, judges vendor fit | totals add up, date in range, remaining budget, duplicates, flags, grounded reasons | code checks still run; manual review |
| `explainTrustScore(breakdown)` | words each component | strength or weakness (75% of points or more), number check | code template |
| `parseDonationRequest(text, { knownCauses })` | amount, currency, cause, location | USD only, amount must be in the text, cause from the list, location must be in the text | dollar amount read by code |
| `routeDonation({ amountCents, shortlist, request })` | suggests a split with reasons | ids exist, exact sum, funding gaps, at most 3, grounded reasons | split by trust score |
| `draftImpactUpdate(facts)` | headline and body | every number must be in the facts | code template |
| `callModel({ schema, system, prompt, images })` | | JSON schema mode, Zod validation, one retry, 20 s timeout per attempt | `invalid_output`, `timeout` or `api_error` |

Flags: `unreadable`, `totals_mismatch`, `date_out_of_range`, `over_budget`, `duplicate`, `vendor_mismatch`, `suspicious_instructions`. Schemas and types live in `packages/shared/src/ai.ts`.

## Guardrails

1. **Data only.** Results are validated with Zod before they leave the package; raw model text is never returned.
2. **Untrusted input.** Every system prompt starts with a fixed notice that document text is data, never an instruction. Receipt text sent back to the model is marked untrusted. Instruction-like text is reported as `suspicious_instructions` and ignored.
3. **Arithmetic in code.** The model copies amounts as printed; code converts them to cents and does all sums, budget and date checks. A model that obeys hidden text still cannot hide a wrong total, because the total is checked in code.
4. **No invented numbers.** Any model-written sentence that cites a number not in its input is replaced by a code-written one (`src/grounding.ts`).
5. **Failures go to people.** Outages, timeouts, bad output and unsupported files never throw; evidence becomes `needs_manual_review`.
6. **Files.** JPG, PNG or PDF up to 5 MB, detected from the bytes, not the name. Only a PDF's first page is rendered.

## Integration guide for the API (Backend owner)

Add `"@your-project/ai": "*"` to `apps/api/package.json` dependencies, then:

**Evidence upload** (`milestone-evidence.routes.ts`): replace `analyzeWithTimeout(file.path)` with

```ts
import { analyzeEvidenceFile } from "@your-project/ai";

const analysis = await analyzeEvidenceFile(file.path, {
  milestone: { id: milestone.id, title: milestone.title, budgetAmountCents: milestone.budgetAmountCents,
               dueDate: milestone.dueDate?.toISOString() ?? null },
  campaign: { id: milestone.campaign.id, title: milestone.campaign.title,
              cause: organization.cause, organizationName: organization.name },
  spentCents,      // sum of paid payouts for this milestone
  priorEvidence,   // [{ id, extraction }] from earlier Evidence.extractedFields of this campaign
});
// extractedFields: analysis.extraction ?? {}, aiFindings: analysis
```

It never throws and can take up to about 80 seconds in the worst case (two model calls, each with one retry), so drop the 5-second `analyzeWithTimeout` wrapper. The reviewer UI should show `analysis.findings.flags`, `checks` and `status` next to the receipt, labelled "AI-assisted checks".

**Trust score**: `explainTrustScore(organization.trustScoreBreakdown)` takes the breakdown exactly as `calculateTrustScore()` stores it.

**Routing assistant**: `parseDonationRequest(text, { knownCauses })`, then shortlist active campaigns in code (marketplace filters plus the dashboard's funding-gap query), then `routeDonation({ amountCents, shortlist, request: text })`. The donor approves the split before any PayPal order is created.

## Known limits

- The database has no campaign start or end dates and no milestone budget lines. Date checks fall back to "not after the milestone due date and not in the future", and budget-line matching only has the milestone title and the organization's cause. Adding `startDate`, `endDate` and `budgetLines` (already optional in the shared schemas) makes both checks stronger.
- The default model id is not yet confirmed against Google AI Studio; set `AI_MODEL` if it differs.
- Free-tier keys have rate limits; the eval spaces calls out, and a 429 during upload becomes manual review.
