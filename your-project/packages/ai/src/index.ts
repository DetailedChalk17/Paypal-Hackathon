// Public API of the AI package. Output is data only: these functions never move
// money, approve anything or hold payment credentials. Results are
// "AI-assisted checks" that a human reviewer acts on.

export { callModel, MODEL_TIMEOUT_MS, UNTRUSTED_INPUT_NOTICE } from "./callModel";
export type { CallModelArgs, CallModelOptions, ModelImage } from "./callModel";
export { DEFAULT_MODEL, DEFAULT_PROVIDER, providerFromEnv } from "./config";
export type { ModelProvider, ProviderRequest } from "./providers/types";
export { MAX_FILE_BYTES, checkReceiptFile, detectFileType } from "./files";
export type { ReceiptFile, DetectedFileType } from "./files";

// Evidence: the API upload route only needs analyzeEvidenceFile
export { analyzeEvidence, analyzeEvidenceFile } from "./analyzeEvidence";
export type { AnalyzeEvidenceInput } from "./analyzeEvidence";
export { extractReceipt, EXTRACTION_PROMPT, EXTRACTION_SYSTEM_PROMPT } from "./extractReceipt";
export { checkEvidence, VENDOR_MATCH_SYSTEM_PROMPT } from "./checkEvidence";
export type { CheckEvidenceOptions } from "./checkEvidence";

// Trust score, routing and impact updates
export { explainTrustScore, TRUST_SYSTEM_PROMPT } from "./explainTrustScore";
export {
  parseDonationRequest,
  routeDonation,
  rankByTrust,
  PARSE_REQUEST_SYSTEM_PROMPT,
  ROUTING_SYSTEM_PROMPT,
} from "./donation";
export type { ParseDonationRequestOptions } from "./donation";
export { draftImpactUpdate, IMPACT_SYSTEM_PROMPT } from "./impactUpdate";
