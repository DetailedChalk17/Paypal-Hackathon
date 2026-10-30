import { createCanvas } from "@napi-rs/canvas";

const RENDER_SCALE = 2; // about 144 dpi, enough for small receipt text

// Renders only the first page of a PDF to PNG bytes. Font loading into the
// runtime and XFA forms are disabled because the PDF is untrusted.
export async function pdfFirstPageToPng(data: Uint8Array): Promise<Uint8Array> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(data), // pdfjs takes ownership of the buffer
    disableFontFace: true,
    enableXfa: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas: canvas as any, canvasContext: canvas.getContext("2d") as any, viewport }).promise;
    return new Uint8Array(canvas.toBuffer("image/png"));
  } finally {
    await task.destroy();
  }
}
