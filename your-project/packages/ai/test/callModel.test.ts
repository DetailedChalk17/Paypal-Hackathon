import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ReceiptExtractionSchema } from "@your-project/shared";
import { UNTRUSTED_INPUT_NOTICE, callModel, toProviderSchema } from "../src/callModel";
import { DEFAULT_MODEL, providerFromEnv } from "../src/config";
import { GeminiProvider } from "../src/providers/gemini";
import { fakeProvider } from "./helpers";

const Schema = z.object({ vendor: z.string(), totalCents: z.number().int() });
const args = { schema: Schema, system: "Read the receipt.", prompt: "Extract vendor and total." };

describe("callModel", () => {
  it("returns validated data on a good answer", async () => {
    const { provider } = fakeProvider('{"vendor":"Acme","totalCents":1250}');
    expect(await callModel(args, { provider })).toEqual({ ok: true, data: { vendor: "Acme", totalCents: 1250 } });
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it("accepts JSON wrapped in a code fence", async () => {
    const { provider } = fakeProvider('```json\n{"vendor":"Acme","totalCents":1}\n```');
    expect((await callModel(args, { provider })).ok).toBe(true);
  });

  it("retries once on invalid output and tells the model why", async () => {
    const { provider, requests } = fakeProvider('{"vendor":"Acme"}', '{"vendor":"Acme","totalCents":5}');
    expect(await callModel(args, { provider })).toEqual({ ok: true, data: { vendor: "Acme", totalCents: 5 } });
    expect(requests).toHaveLength(2);
    expect(requests[1].prompt).toContain("not valid JSON");
  });

  it("gives up with invalid_output after the retry, never returning raw text", async () => {
    const { provider } = fakeProvider("Sure! The total is $12.50", '{"vendor":42}', '{"vendor":"x","totalCents":1}');
    expect(await callModel(args, { provider })).toEqual({ ok: false, reason: "invalid_output" });
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });

  it("returns timeout and aborts the request when the provider hangs", async () => {
    const { provider, requests } = fakeProvider("hang");
    expect(await callModel(args, { provider, timeoutMs: 20 })).toEqual({ ok: false, reason: "timeout" });
    expect(requests[0].signal.aborted).toBe(true);
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it("returns api_error when the provider throws (outage, rate limit, bad key)", async () => {
    const { provider } = fakeProvider(new Error("503 Service Unavailable"));
    expect(await callModel(args, { provider })).toEqual({ ok: false, reason: "api_error" });
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it("always prepends the untrusted-input notice and sends schema and images", async () => {
    const { provider, requests } = fakeProvider('{"vendor":"A","totalCents":1}');
    const image = { mediaType: "image/png" as const, data: Uint8Array.from([1, 2, 3]) };
    await callModel({ ...args, images: [image] }, { provider });
    expect(requests[0].system.startsWith(UNTRUSTED_INPUT_NOTICE)).toBe(true);
    expect(requests[0].system).toContain("Read the receipt.");
    expect(requests[0].images).toEqual([image]);
    expect(requests[0].jsonSchema).toMatchObject({ type: "object", required: ["vendor", "totalCents"] });
  });
});

describe("toProviderSchema", () => {
  it("drops $schema and regex patterns but keeps structure", () => {
    const json = JSON.stringify(toProviderSchema(ReceiptExtractionSchema));
    expect(json).not.toContain('"$schema"');
    expect(json).not.toContain('"pattern"');
    expect(json).toContain('"lineItems"');
    expect(json).toContain('"null"');
  });
});

describe("providerFromEnv", () => {
  it("returns null without a key, so calls fail as api_error instead of crashing", () => {
    expect(providerFromEnv({})).toBeNull();
    expect(providerFromEnv({ AI_API_KEY: "  " })).toBeNull();
  });

  it("defaults to Gemini and honours AI_MODEL", () => {
    expect(providerFromEnv({ AI_API_KEY: "k" })).toMatchObject({ name: "gemini", model: DEFAULT_MODEL });
    expect(providerFromEnv({ AI_API_KEY: "k", AI_MODEL: "gemini-x" })?.model).toBe("gemini-x");
    expect(providerFromEnv({ AI_API_KEY: "k", AI_PROVIDER: "unknown" })).toBeNull();
  });
});

describe("GeminiProvider", () => {
  it("builds a JSON-mode request with base64 images and returns the text", async () => {
    const generateContent = vi.fn(async (_params: any) => ({ text: '{"ok":1}' }) as any);
    const gemini = new GeminiProvider("gemini-test", "unused", generateContent);
    const signal = new AbortController().signal;
    const text = await gemini.generate({
      system: "sys",
      prompt: "prompt",
      images: [{ mediaType: "image/jpeg", data: Uint8Array.from([0xff, 0xd8]) }],
      jsonSchema: { type: "object" },
      signal,
    });

    expect(text).toBe('{"ok":1}');
    const params = generateContent.mock.calls[0][0];
    expect(params.model).toBe("gemini-test");
    expect(params.contents[0].parts).toEqual([
      { inlineData: { mimeType: "image/jpeg", data: "/9g=" } },
      { text: "prompt" },
    ]);
    expect(params.config).toMatchObject({
      systemInstruction: "sys",
      responseMimeType: "application/json",
      responseJsonSchema: { type: "object" },
      temperature: 0,
      abortSignal: signal,
    });
  });

  it("throws when Gemini returns no text (for example a blocked answer)", async () => {
    const gemini = new GeminiProvider("m", "k", vi.fn(async () => ({ text: undefined }) as any));
    await expect(
      gemini.generate({ system: "", prompt: "", images: [], jsonSchema: {}, signal: new AbortController().signal })
    ).rejects.toThrow();
  });
});
