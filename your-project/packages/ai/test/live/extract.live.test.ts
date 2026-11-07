import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { providerFromEnv } from "../../src/config";
import { extractReceipt } from "../../src/extractReceipt";

// Live A3 check against the real model. Run: npm run test:live
// Target: at least 12 of the 15 non-injection receipts right. A readable receipt
// is right when vendor and total match; the blurry one is right when it comes
// back with low confidence and no wrong total.

try {
  process.loadEnvFile(join(__dirname, "../../../../.env"));
} catch {
  // no .env: providerFromEnv() reports the missing key below
}

const DIR = join(__dirname, "../../../../scripts/receipts");
const receipts = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8")).receipts as any[];
const LOW_CONFIDENCE = 0.3;

const normVendor = (v: string | null) =>
  (v ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

describe("live receipt extraction", () => {
  it("gets vendor and total right on at least 12 of 15 receipts", async () => {
    const provider = providerFromEnv();
    if (!provider) throw new Error("AI_API_KEY is not set in your-project/.env");
    console.log(`Model: ${provider.name} ${provider.model}`);

    const rows: string[] = [];
    let right = 0;
    const scored = receipts.filter((r) => !r.injection);

    for (const r of scored) {
      if (rows.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 4200));
      }
      const file = { data: new Uint8Array(readFileSync(join(DIR, r.file))), filename: r.file };
      const res = await extractReceipt(file, { provider });
      let ok = false;
      let got = "";
      if (!res.ok) {
        got = `failed: ${res.reason}`;
      } else {
        const d = res.data;
        got = `${d.vendor ?? "null"} | ${d.totalCents ?? "null"} | conf ${d.confidence}`;
        ok = r.readable
          ? normVendor(d.vendor) === normVendor(r.expected.vendor) && d.totalCents === r.expected.totalCents
          : d.confidence <= LOW_CONFIDENCE && (d.totalCents === null || d.totalCents === r.expected.totalCents);
      }
      if (ok) right++;
      rows.push(`${ok ? "PASS" : "FAIL"} ${r.id}  expected ${r.expected.vendor} | ${r.expected.totalCents}  got ${got}`);
    }

    console.log(`\n${rows.join("\n")}\n\n${right}/${scored.length} right (target 12)`);
    expect(right).toBeGreaterThanOrEqual(12);
  });
});
