import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReceiptExtractionSchema } from "@your-project/shared";
import {
  EXTRACTION_SYSTEM_PROMPT,
  extractReceipt,
  normalizeReceipt,
  type ModelReceipt,
} from "../src/extractReceipt";
import { MAX_FILE_BYTES, detectFileType } from "../src/files";
import { parseMoneyToCents, parseQuantity } from "../src/money";
import { fakeProvider } from "./helpers";

const DIR = join(__dirname, "../../../scripts/receipts");
const fixtures = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8")).receipts as any[];
const load = (file: string) => ({ data: new Uint8Array(readFileSync(join(DIR, file))), filename: file });

const dollars = (cents: number) => (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

// What a perfect model would return for a fixture: values copied as printed.
function perfectAnswer(expected: any): ModelReceipt {
  return {
    readability: "clear",
    vendor: expected.vendor,
    date: expected.date,
    currency: "USD",
    lineItems: expected.lineItems.map((i: any) => ({
      description: i.description,
      quantity: String(i.quantity),
      unitPrice: dollars(i.unitPriceCents),
      total: dollars(i.totalCents),
    })),
    subtotal: dollars(expected.subtotalCents),
    tax: dollars(expected.taxCents),
    total: dollars(expected.totalCents),
    confidence: 0.95,
  };
}

const goodAnswer: ModelReceipt = {
  readability: "clear",
  vendor: "Voltline Electronics",
  date: "2026-09-14",
  currency: "usd",
  lineItems: [{ description: "Servo", quantity: "6", unitPrice: "11.50", total: "69.00" }],
  subtotal: "1,069.00",
  tax: "$88.19",
  total: "1157.19",
  confidence: 0.9,
};

describe("parseMoneyToCents", () => {
  it.each([
    ["163.79", 16379], ["$1,234.50", 123450], ["12", 1200], ["12.5", 1250], ["0.05", 5], ["USD 7.00", 700],
  ])("%s -> %i", (input, cents) => expect(parseMoneyToCents(input)).toBe(cents));

  it.each([["12.345"], ["-5.00"], ["abc"], [""], ["1.2.3"], ["€5"]])("%s -> null", (input) =>
    expect(parseMoneyToCents(input)).toBeNull()
  );

  it("parses quantities and rejects junk", () => {
    expect(parseQuantity("2")).toBe(2);
    expect(parseQuantity("1.5")).toBe(1.5);
    expect(parseQuantity("two")).toBeNull();
  });
});

describe("normalizeReceipt", () => {
  it("converts printed amounts to cents in code and uppercases the currency", () => {
    expect(normalizeReceipt(goodAnswer)).toEqual({
      vendor: "Voltline Electronics",
      date: "2026-09-14",
      currency: "USD",
      lineItems: [{ description: "Servo", quantity: 6, unitPriceCents: 1150, totalCents: 6900 }],
      subtotalCents: 106900,
      taxCents: 8819,
      totalCents: 115719,
      confidence: 0.9,
    });
  });

  it("drops every value when the model says the document is unreadable", () => {
    const r = normalizeReceipt({ ...goodAnswer, readability: "unreadable", confidence: 0.8 });
    expect(r).toMatchObject({ vendor: null, date: null, totalCents: null, lineItems: [], confidence: 0.2 });
  });

  it("caps confidence for partly readable receipts and missing key fields", () => {
    expect(normalizeReceipt({ ...goodAnswer, readability: "partly_readable" }).confidence).toBe(0.6);
    expect(normalizeReceipt({ ...goodAnswer, vendor: null, total: null }).confidence).toBe(0.6);
    expect(normalizeReceipt({ ...goodAnswer, vendor: null, date: null, total: null }).confidence).toBeCloseTo(0.4);
  });

  it("nulls values that are not in the expected format instead of guessing", () => {
    const r = normalizeReceipt({ ...goodAnswer, date: "Sept 14", currency: "$", total: "about 12", vendor: "  " });
    expect(r).toMatchObject({ date: null, currency: null, totalCents: null, vendor: null });
    expect(r.confidence).toBeCloseTo(0.4);
  });
});

describe("extractReceipt", () => {
  it("rejects unsupported, empty and oversized files without calling the model", async () => {
    const { provider } = fakeProvider();
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const data of [new TextEncoder().encode("GIF89a..."), new Uint8Array(), big]) {
      expect(await extractReceipt({ data, filename: "receipt.png" }, { provider })).toEqual({
        ok: false,
        reason: "unsupported_file",
      });
    }
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("returns unsupported_file for a corrupt PDF", async () => {
    const { provider } = fakeProvider();
    const r = await extractReceipt({ data: new TextEncoder().encode("%PDF-1.7\ngarbage") }, { provider });
    expect(r).toEqual({ ok: false, reason: "unsupported_file" });
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("sends an image with the extraction prompt and returns a valid extraction", async () => {
    const { provider, requests } = fakeProvider(JSON.stringify(goodAnswer));
    const r = await extractReceipt(load("r01.png"), { provider });
    expect(r.ok).toBe(true);
    if (r.ok) expect(ReceiptExtractionSchema.parse(r.data)).toEqual(r.data);
    expect(requests[0].system).toContain(EXTRACTION_SYSTEM_PROMPT);
    expect(requests[0].images).toHaveLength(1);
    expect(requests[0].images[0].mediaType).toBe("image/png");
  });

  it("sends JPGs as JPEG", async () => {
    const { provider, requests } = fakeProvider(JSON.stringify(goodAnswer));
    await extractReceipt(load("r03.jpg"), { provider });
    expect(requests[0].images[0].mediaType).toBe("image/jpeg");
  });

  it("converts a PDF's first page to a PNG before calling the model", async () => {
    const { provider, requests } = fakeProvider(JSON.stringify(goodAnswer));
    const r = await extractReceipt(load("r08.pdf"), { provider });
    expect(r.ok).toBe(true);
    const image = requests[0].images[0];
    expect(image.mediaType).toBe("image/png");
    expect(detectFileType(image.data)).toBe("image/png");
    expect(image.data.length).toBeGreaterThan(10_000); // a real rendered page, not an empty canvas
  });

  it.each([
    ["timeout", "hang"],
    ["api_error", new Error("429 quota exceeded")],
    ["invalid_output", "not json"],
  ] as const)("passes through %s from the model call", async (reason, answer) => {
    const { provider } = fakeProvider(answer as any, answer as any);
    expect(await extractReceipt(load("r01.png"), { provider, timeoutMs: 20 })).toEqual({ ok: false, reason });
  });

  // Runs every fixture through the real pipeline with a model that copies the
  // printed values; checks file handling and the text-to-cents conversion end to end.
  it.each(fixtures.map((f) => [f.id, f]))("%s: a perfect transcription yields the expected values", async (_id, f) => {
    const { provider } = fakeProvider(JSON.stringify(perfectAnswer(f.expected)));
    const r = await extractReceipt(load(f.file), { provider });
    if (!r.ok) throw new Error(`failed: ${r.reason}`);
    expect(r.data).toEqual({ ...f.expected, confidence: 0.95 });
  });
});
