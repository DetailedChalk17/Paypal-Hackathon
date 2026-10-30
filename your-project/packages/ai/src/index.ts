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
  checkEvidence,
  explainTrustScore,
  parseDonationRequest,
  routeDonation,
} from "./stubs";

// callModel is real; the task functions are stubs until steps A3 to A6 land.
export const AI_IMPLEMENTATION = "stub" as const;
