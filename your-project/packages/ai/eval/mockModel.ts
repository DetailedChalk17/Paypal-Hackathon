import { EXTRACTION_SYSTEM_PROMPT } from "../src/extractReceipt";
import { VENDOR_MATCH_SYSTEM_PROMPT } from "../src/checkEvidence";
import type { ModelProvider, ProviderRequest } from "../src/providers/types";
import type { Fixture } from "./fixtures";

// A "perfect" model for --mock runs: answers each receipt's questions with the
// ground truth, so the eval can verify the pipeline and scoring without an API
// key. Every other prompt gets an error, which exercises the code fallbacks.

const dollars = (cents: number) => (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

export function perfectExtraction(f: Fixture) {
  if (!f.readable) {
    return {
      readability: "unreadable", vendor: null, date: null, currency: null, lineItems: [],
      subtotal: null, tax: null, total: null, confidence: 0.15, instructionsDetected: false,
    };
  }
  const e = f.expected;
  return {
    readability: "clear",
    vendor: e.vendor,
    date: e.date,
    currency: "USD",
    lineItems: e.lineItems.map((i) => ({
      description: i.description,
      quantity: String(i.quantity),
      unitPrice: i.unitPriceCents === null ? null : dollars(i.unitPriceCents),
      total: i.totalCents === null ? null : dollars(i.totalCents),
    })),
    subtotal: e.subtotalCents === null ? null : dollars(e.subtotalCents),
    tax: e.taxCents === null ? null : dollars(e.taxCents),
    total: e.totalCents === null ? null : dollars(e.totalCents),
    confidence: 0.95,
    instructionsDetected: f.injection,
  };
}

export function mockProviderFor(f: Fixture | null): ModelProvider {
  return {
    name: "mock",
    model: "perfect-fixture-model",
    async generate(req: ProviderRequest) {
      if (f && req.system.includes(EXTRACTION_SYSTEM_PROMPT)) return JSON.stringify(perfectExtraction(f));
      if (f && req.system.includes(VENDOR_MATCH_SYSTEM_PROMPT)) {
        const fits = !f.expectedFlags.includes("vendor_mismatch");
        return JSON.stringify({
          matchedBudgetLineId: f.expectedBudgetLineId,
          vendorFits: fits,
          reason: fits ? "The vendor fits this milestone." : "This vendor does not fit the milestone.",
          confidence: 0.9,
        });
      }
      throw new Error("mock model: no answer for this prompt");
    },
  };
}
