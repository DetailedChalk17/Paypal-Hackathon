import { readFile } from "node:fs/promises";
import {
  AI_CHECKS_LABEL,
  EvidenceAnalysisSchema,
  type AiFailReason,
  type CheckEvidenceInput,
  type EvidenceAnalysis,
} from "@your-project/shared";
import { checkEvidence, type CheckEvidenceOptions } from "./checkEvidence";
import { providerFromEnv } from "./config";
import { extractReceipt } from "./extractReceipt";
import type { ReceiptFile } from "./files";

export type AnalyzeEvidenceInput = Omit<CheckEvidenceInput, "extraction"> & { file: ReceiptFile };

// The one call the API's upload route needs: extraction, then checks.
// Never throws. Any failure (outage, timeout, bad output, unsupported file)
// returns status "needs_manual_review" so the reviewer checks by hand.
// The result is data only; it never approves anything or moves money.
export async function analyzeEvidence(
  input: AnalyzeEvidenceInput,
  options: CheckEvidenceOptions = {}
): Promise<EvidenceAnalysis> {
  const provider = options.provider === undefined ? providerFromEnv() : options.provider;
  const opts = { ...options, provider };
  const base = { label: AI_CHECKS_LABEL as typeof AI_CHECKS_LABEL, model: provider ? `${provider.name}/${provider.model}` : null };
  const manual = (failureReason: AiFailReason, extraction: EvidenceAnalysis["extraction"] = null): EvidenceAnalysis => ({
    ...base,
    status: "needs_manual_review",
    failureReason,
    extraction,
    findings: null,
    analyzedAt: new Date().toISOString(),
  });

  try {
    const extracted = await extractReceipt(input.file, opts);
    if (!extracted.ok) return manual(extracted.reason);

    const { file: _file, ...context } = input;
    const checked = await checkEvidence({ ...context, extraction: extracted.data }, opts);
    if (!checked.ok) return manual(checked.reason, extracted.data);

    return EvidenceAnalysisSchema.parse({
      ...base,
      status: "completed", // flags for the reviewer are in findings.needsManualReview

      failureReason: null,
      extraction: extracted.data,
      findings: checked.data,
      analyzedAt: new Date().toISOString(),
    });
  } catch {
    return manual("api_error");
  }
}

// Convenience for the upload route, which has the file on disk (multer).
export async function analyzeEvidenceFile(
  filePath: string,
  context: Omit<AnalyzeEvidenceInput, "file">,
  options: CheckEvidenceOptions = {}
): Promise<EvidenceAnalysis> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(await readFile(filePath));
  } catch {
    return analyzeEvidence({ ...context, file: { data: new Uint8Array() } }, options); // -> unsupported_file
  }
  return analyzeEvidence({ ...context, file: { data, filename: filePath } }, options);
}
