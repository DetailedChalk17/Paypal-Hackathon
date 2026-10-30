// Public API of the AI package. Output is data only: these functions never move
// money, approve anything or hold payment credentials. Results are
// "AI-assisted checks" that a human reviewer acts on.

export { callModel, MODEL_TIMEOUT_MS, UNTRUSTED_INPUT_NOTICE } from "./callModel";
export type { CallModelArgs, CallModelOptions, ModelImage } from "./callModel";
export { DEFAULT_MODEL, DEFAULT_PROVIDER, providerFromEnv } from "./config";
export type { ModelProvider, ProviderRequest } from "./providers/types";
export { MAX_FILE_BYTES, checkReceiptFile, detectFileType } from "./files";
export type { ReceiptFile, DetectedFileType } from "./files";
export {
  extractReceipt,
  EXTRACTION_PROMPT,
  EXTRACTION_SYSTEM_PROMPT,
} from "./extractReceipt";
export {
  checkEvidence,
  explainTrustScore,
  parseDonationRequest,
  routeDonation,
} from "./stubs";

// Which exports are real and which still return canned data.
export const AI_IMPLEMENTATION = {
  callModel: "real",
  extractReceipt: "real",
  checkEvidence: "stub",
  explainTrustScore: "stub",
  parseDonationRequest: "stub",
  routeDonation: "stub",
} as const;
