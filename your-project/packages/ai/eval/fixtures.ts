import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CheckEvidenceInput,
  EvidenceFlagType,
  ReceiptExtraction,
} from "@your-project/shared";

// Loads scripts/receipts (the synthetic eval set) and builds the context each
// receipt is checked against. Shared by unit tests and the eval script.

export const RECEIPTS_DIR = join(__dirname, "../../../scripts/receipts");
// Receipts are dated Sep-Oct 2026; checks run "as of" this date.
export const EVAL_NOW = new Date("2026-11-07T12:00:00Z");

export type Fixture = {
  id: string;
  file: string;
  problem: string | null;
  injection: boolean;
  readable: boolean;
  milestoneId: string;
  expectedBudgetLineId: string | null;
  spentCents: number;
  priorEvidenceIds: string[];
  expectedFlags: EvidenceFlagType[];
  optionalFlags: EvidenceFlagType[];
  expected: Omit<ReceiptExtraction, "confidence">;
  notes: string | null;
};

const data = JSON.parse(readFileSync(join(RECEIPTS_DIR, "expected.json"), "utf8"));
export const campaign = data.campaign as { id: string; title: string; startDate: string; endDate: string };
export const milestones = data.milestones as Array<{
  id: string;
  title: string;
  budgetAmountCents: number;
  budgetLines: Array<{ id: string; label: string; amountCents: number }>;
}>;
export const fixtures = data.receipts as Fixture[];
const byId = new Map(fixtures.map((f) => [f.id, f]));

export const loadFile = (f: Fixture) => ({
  data: new Uint8Array(readFileSync(join(RECEIPTS_DIR, f.file))),
  filename: f.file,
});

// Everything checkEvidence needs except the extraction itself.
export function contextFor(f: Fixture): Omit<CheckEvidenceInput, "extraction"> {
  const milestone = milestones.find((m) => m.id === f.milestoneId)!;
  return {
    milestone,
    campaign: { ...campaign, cause: "Education", organizationName: "Riverside Youth Robotics Club" },
    spentCents: f.spentCents,
    priorEvidence: f.priorEvidenceIds.map((id) => ({
      id,
      extraction: { ...byId.get(id)!.expected, confidence: 0.95 },
    })),
  };
}

// The extraction a perfect reader would produce (the blurry receipt reads as unreadable).
export function idealExtraction(f: Fixture): ReceiptExtraction {
  if (!f.readable) {
    return {
      vendor: null, date: null, currency: null, lineItems: [],
      subtotalCents: null, taxCents: null, totalCents: null,
      confidence: 0.2, instructionsDetected: false,
    };
  }
  return { ...f.expected, confidence: 0.95, instructionsDetected: f.injection };
}

// Flags are right when every required flag is raised and nothing outside
// required + optional is raised.
export function flagsCorrect(f: Fixture, raised: EvidenceFlagType[]): boolean {
  const allowed = new Set([...f.expectedFlags, ...f.optionalFlags]);
  return f.expectedFlags.every((t) => raised.includes(t)) && raised.every((t) => allowed.has(t));
}
