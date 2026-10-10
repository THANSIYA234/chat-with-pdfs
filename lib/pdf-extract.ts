/**
 * PDF extraction primitives (text + page renders + embedded images).
 *
 * Wraps `unpdf` so the rest of the pipeline never imports it directly.
 *
 * Three outputs per page, all aligned by 1-indexed `page`:
 *   - `text`        — joined `getTextContent()` items, skipping empties.
 *                     Empty string means "no extractable text" (scanned
 *                     page, image-only PDF).
 *   - `pagePng`     — rendered page at `RENDER_DPI`, downscaled so the
 *                     larger side ≤ `MAX_IMAGE_PIXELS`. Used for
 *                     rendered-page OCR + rendered-page vision.
 *   - `embedded`    — every embedded raster on the page, raw RGBA from
 *                     `unpdf` then re-encoded via `sharp` into PNG so
 *                     downstream code only ever sees PNG buffers.
 *
 * Skips blank pages rather than rendering them: saves time and avoids
 * vision-model calls on useless white pages.
 */
import { extractImages, renderPageAsImage, getDocumentProxy } from "unpdf";
import sharp from "sharp";

import { env } from "@/lib/env";

/**
 * Alias for the unpdf `PDFDocumentProxy` runtime shape we hold across
 * the lifetime of one upload. `unpdf` doesn't re-export the canonical
 * type from its public `exports` map, but the concrete shape is
 * stable — `numPages`, `getPage(n)`, and pass-through to
 * `renderPageAsImage` / `extractImages` are the only surface we need.
 */
type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

export interface ExtractedPage {
  page: number;
  /** Native text extracted via `unpdf` getTextContent ("" if scanned). */
  text: string;
  /** Whole page rendered at `RENDER_DPI`, downscaled PNG (Buffer or null). */
  pagePng: Buffer | null;
  /** Every embedded raster on the page, normalised to PNG (Buffer). */
  embedded: Buffer[];
  /** Whether this page looks "thin" — text barely covers the page. */
  isThin: boolean;
}

/**
 * Apply a coarse "is this text-rich?" heuristic: fewer than 30
 * alphanumeric characters per page means OCR/vision probably needs to
 * run on the page render. Cheap and tunable.
 */
const THIN_TEXT_CHARS = 30;

function isThinText(text: string): boolean {
  const alphanumeric = text.replace(/[^a-zA-Z0-9]/g, "");
  return alphanumeric.length < THIN_TEXT_CHARS;
}

async function loadEmbeddedAsPng(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  channels: 1 | 3 | 4,
  maxSide: number,
): Promise<Buffer | null> {
  if (width <= 0 || height <= 0 || data.byteLength === 0) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  try {
    const pipeline = sharp(buf, {
      raw: { width, height, channels },
    }).png();
    if (Math.max(width, height) > maxSide) {
      pipeline.resize({
        width: width >= height ? maxSide : undefined,
        height: height > width ? maxSide : undefined,
        fit: "inside",
      });
    }
    return await pipeline.toBuffer();
  } catch (err) {
    console.warn("[pdf-extract] embedded image convert failed", err);
    return null;
  }
}

async function renderPagePng(
  pdf: PdfDocument,
  page: number,
): Promise<Buffer | null> {
  try {
    const arr = await renderPageAsImage(pdf, page, {
      scale: env.RENDER_DPI,
      canvasImport: () => import("@napi-rs/canvas"),
    });
    const buf = Buffer.from(arr);
    const meta = await sharp(buf).metadata().catch(() => null);
    if (!meta?.width || !meta?.height) return buf;
    const maxSide = env.MAX_IMAGE_PIXELS;
    if (Math.max(meta.width, meta.height) > maxSide) {
      return await sharp(buf)
        .resize({
          width: meta.width >= meta.height ? maxSide : undefined,
          height: meta.height > meta.width ? maxSide : undefined,
          fit: "inside",
        })
        .png()
        .toBuffer();
    }
    return buf;
  } catch (err) {
    // Page rendering can fail on some PDFs (broken XObjects, missing
    // fonts, encryption); we log and continue so the rest of the doc
    // still indexes.
    console.warn(`[pdf-extract] page ${page} render failed`, err);
    return null;
  }
}

async function extractTextFromPage(
  pdf: PdfDocument,
  page: number,
): Promise<string> {
  try {
    const proxy = await pdf.getPage(page);
    const tc = await proxy.getTextContent();
    const text = tc.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return text;
  } catch (err) {
    console.warn(`[pdf-extract] page ${page} text failed`, err);
    return "";
  }
}

export async function extractDocument(buf: Uint8Array): Promise<ExtractedPage[]> {
  const pdf: PdfDocument = await getDocumentProxy(buf);
  const total = pdf.numPages;
  const out: ExtractedPage[] = [];
  for (let p = 1; p <= total; p++) {
    const text = await extractTextFromPage(pdf, p);

    // Decide if we should bother rendering this page. We always render
    // thin pages (where text is sparse) AND any page where
    // `extractImages` returns at least one raster — a product photo
    // with a one-line brand stamp still needs the visual context that
    // OCR alone cannot recover.
    const thin = isThinText(text);
    const embedded: Buffer[] = [];
    try {
      const images = await extractImages(pdf, p);
      for (const im of images) {
        const png = await loadEmbeddedAsPng(
          im.data,
          im.width,
          im.height,
          im.channels,
          env.MAX_IMAGE_PIXELS,
        );
        if (png) embedded.push(png);
      }
    } catch (err) {
      console.warn(`[pdf-extract] page ${p} embedded images failed`, err);
    }
    const shouldRender = thin || embedded.length > 0;
    const pagePng: Buffer | null = shouldRender ? await renderPagePng(pdf, p) : null;
    console.log(
      `[pdf-extract] page ${p}/${total}: text.len=${text.length} thin=${thin} ` +
        `rendered=${pagePng !== null} embedded=${embedded.length}`,
    );
    out.push({ page: p, text, pagePng, embedded, isThin: thin });
  }
  return out;
}

/** Best-effort page count for early validation / logs. */
export async function numPages(buf: Uint8Array): Promise<number> {
  const pdf: PdfDocument = await getDocumentProxy(buf);
  return pdf.numPages;
}
