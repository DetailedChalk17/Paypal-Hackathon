import type { ModelProvider, ProviderRequest } from "./types";
import { EXTRACTION_SYSTEM_PROMPT } from "../extractReceipt";
import { VENDOR_MATCH_SYSTEM_PROMPT } from "../checkEvidence";
import { TRUST_SYSTEM_PROMPT } from "../explainTrustScore";
import { PARSE_REQUEST_SYSTEM_PROMPT, ROUTING_SYSTEM_PROMPT } from "../donation";
import { IMPACT_SYSTEM_PROMPT } from "../impactUpdate";

export class MockProvider implements ModelProvider {
  readonly name = "mock";
  readonly model = "mock-eval-model";

  async generate(req: ProviderRequest): Promise<string> {
    if (req.system.includes(EXTRACTION_SYSTEM_PROMPT)) {
      return JSON.stringify({
        readability: "clear",
        vendor: "Acme Community Supplies",
        date: "2026-10-15",
        currency: "USD",
        lineItems: [
          { description: "Classroom Whiteboards & Projector Mounts", quantity: "4", unitPrice: "250.00", total: "1000.00" },
          { description: "Educational Cabling & Materials", quantity: "1", unitPrice: "250.00", total: "250.00" },
        ],
        subtotal: "1250.00",
        tax: "0.00",
        total: "1250.00",
        confidence: 0.95,
        instructionsDetected: false,
      });
    }

    if (req.system.includes(VENDOR_MATCH_SYSTEM_PROMPT)) {
      const idMatch = /"id":\s*"([^"]+)"/.exec(req.prompt);
      return JSON.stringify({
        matchedBudgetLineId: idMatch ? idMatch[1] : null,
        vendorFits: true,
        reason: "The vendor appears to fit this milestone.",
        confidence: 0.95,
      });
    }

    if (req.system.includes(TRUST_SYSTEM_PROMPT)) {
      const keys = Array.from(req.prompt.matchAll(/"key":\s*"([^"]+)"/g)).map((m) => m[1]);
      const items = keys.length
        ? keys.map((k) => ({ key: k, text: `The organization maintains consistent compliance on ${k}.` }))
        : [
            { key: "budgetCompliance", text: "1 of 1 campaigns had milestone budgets that fit within the campaign goal." },
            { key: "approvedWithEvidence", text: "2 of 2 milestones were approved by a reviewer with evidence." },
          ];
      return JSON.stringify({ items });
    }

    if (req.system.includes(PARSE_REQUEST_SYSTEM_PROMPT)) {
      const match = /\$?\s*(\d+)/.exec(req.prompt);
      const amountStr = match ? match[1] : "50";
      return JSON.stringify({
        amount: amountStr,
        currency: "USD",
        cause: "Education",
        location: null,
      });
    }

    if (req.system.includes(ROUTING_SYSTEM_PROMPT)) {
      const targetMatch = /Target amount:\s*(\d+)/.exec(req.prompt);
      const target = targetMatch ? Number(targetMatch[1]) : 2500;
      const idMatch = /"campaignId":\s*"([^"]+)"/.exec(req.prompt);
      const cid = idMatch ? idMatch[1] : "30000000-0000-4000-8000-000000000001";
      return JSON.stringify({
        allocations: [
          { campaignId: cid, amountCents: target, reason: "Matches your stated giving goal and funding gap." },
        ],
      });
    }

    if (req.system.includes(IMPACT_SYSTEM_PROMPT)) {
      return JSON.stringify({
        headline: "Milestone Deliverables Complete",
        body: "All supplies have been verified and recorded on the tamper-evident ledger.",
      });
    }

    throw new Error(`MockProvider: unhandled prompt for system ${req.system.slice(0, 30)}`);
  }
}

