// Public API of the AI package. Output is data only: these functions never move
// money, approve anything or hold payment credentials. Results are
// "AI-assisted checks" that a human reviewer acts on.

export { callModel, MODEL_TIMEOUT_MS } from "./callModel";
export type { CallModelArgs, ModelImage } from "./callModel";
export { MAX_FILE_BYTES, checkReceiptFile, detectFileType } from "./files";
export type { ReceiptFile, DetectedFileType } from "./files";
export {
  extractReceipt,
  checkEvidence,
  explainTrustScore,
  parseDonationRequest,
  routeDonation,
} from "./stubs";

// Which implementation is behind the exports: "stub" until steps A3 to A6 land.
export const AI_IMPLEMENTATION = "stub" as const;
