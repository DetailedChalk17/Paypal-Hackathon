const evidencePreviews = new Map<string, string>();

export function saveEvidencePreview(evidenceId: string, file: File) {
  const previous = evidencePreviews.get(evidenceId);
  if (previous) URL.revokeObjectURL(previous);
  evidencePreviews.set(evidenceId, URL.createObjectURL(file));
}

export function getEvidencePreview(evidenceId: string) {
  return evidencePreviews.get(evidenceId);
}
