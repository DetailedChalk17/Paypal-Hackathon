// Uploaded files are untrusted. The type is detected from the file's bytes,
// never from the filename or a client-supplied MIME type.

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export type ReceiptFile = {
  data: Uint8Array; // a Node Buffer works too
  filename?: string; // informational only
};

export type DetectedFileType = "image/jpeg" | "image/png" | "application/pdf";

export function detectFileType(data: Uint8Array): DetectedFileType | null {
  const startsWith = (bytes: number[]) =>
    data.length >= bytes.length && bytes.every((b, i) => data[i] === b);

  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // "%PDF-"
  return null;
}

export type FileCheck =
  | { ok: true; type: DetectedFileType }
  | { ok: false; reason: "unsupported_file" };

export function checkReceiptFile(file: ReceiptFile): FileCheck {
  if (!file?.data || file.data.length === 0 || file.data.length > MAX_FILE_BYTES) {
    return { ok: false, reason: "unsupported_file" };
  }
  const type = detectFileType(file.data);
  return type ? { ok: true, type } : { ok: false, reason: "unsupported_file" };
}
