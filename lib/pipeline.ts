/**
 * Upload-time pipeline orchestrator.
 *
 * Steps, in order:
 *
 *   1. `extractDocument(buf)` — text, page renders, embedded images per page.
 *   2. For each page:
 *        a. Native text → emit one "text" chunk per page.
 *        b. If a rendered page exists (thin pages, or any page that
 *           contains embedded rasters):
 *             - OCR it (recover any text the PDF didn't expose).
 *             - Describe it with the vision model (charts, photos,
 *               scanned tables — anything OCR can't read).
 *        c. For each unique (by sha-256) embedded image → describe it
 *           with the vision model; emit an "image_description" chunk per
 *           image. The first source of description (embedded image OR
 *           rendered page) covers the visual content; both are kept so
 *           retrieval can fall back to whichever was clearer.
 *
 *   3. Hand the assembled paragraphs (each tagged with a `source_type`
 *      + optional `image_hash`) to the existing chunker → embedder.
 *
 * Failures inside one page never abort the whole upload: every step
 * has its own catch. Vision errors are recorded as `warnings` on the
 * result so the caller (the upload route) can surface them in the API
 * response — we never silently substitute OCR garbage or pretend the
 * image was described.
 *
 * Concurrency: pages run sequentially to avoid blowing past OCR's
 * single-worker model or piling up vision-model rate limits.
 */
import { extractDocument, type ExtractedPage } from "@/lib/pdf-extract";
import { ocrImage } from "@/lib/ocr";
import {
  describeImage,
  describeRenderedPage,
  type DescribeFn,
  VisionError,
} from "@/lib/vision";
import { sha256Prefix, SessionImageCache } from "@/lib/image-cache";

/** Three-way classification of why a chunk exists. */
export type SourceType = "text" | "ocr" | "image_description";

/** Atomic piece of content extracted from one PDF page. */
export interface PipelineItem {
  page: number;
  sourceType: SourceType;
  text: string;
  /** sha-256 prefix of the source image; only set for `image_description`. */
  imageHash?: string;
}

/** Non-fatal pipeline anomaly that we want the upload route to report. */
export interface PipelineWarning {
  page: number;
  stage: "render" | "ocr" | "page-vision" | "image-vision";
  message: string;
}

export interface PipelineResult {
  items: PipelineItem[];
  warnings: PipelineWarning[];
  /** Per-page stats so the upload route can report rich status info. */
  stats: {
    pages: number;
    textPages: number;
    renderedPages: number;
    embeddedImages: number;
    describedImages: number;
    ocrPages: number;
    failedPages: number;
  };
}

/** Reject anything smaller than ~16×16 — typically logos / icons. */
const MIN_IMAGE_PIXELS = 16 * 16;

async function describeAndMaybeHash(
  png: Buffer,
  page: number,
  cache: SessionImageCache,
  describeFn: DescribeFn | undefined,
): Promise<
  | { hash: string; description: string | null }
  | { hash: string; description: null; error: VisionError }
> {
  if (png.byteLength < MIN_IMAGE_PIXELS) {
    return { hash: "", description: null };
  }
  const hash = sha256Prefix(png);
  const previous = cache.previousDescription(hash);
  if (previous !== undefined) {
    // Already classified within this session.
    return previous === null
      ? { hash, description: null }
      : { hash, description: previous };
  }
  let description: string | null = null;
  let error: VisionError | null = null;
  try {
    const out = await describeImage(png, describeFn);
    description = out.trim() === "" ? null : out.trim();
  } catch (err) {
    error =
      err instanceof VisionError
        ? err
        : new VisionError(
            `[pipeline] page ${page} image-vision failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
            { provider: "unknown", model: "unknown", cause: err },
          );
  }
  cache.record(hash, description);
  if (error) return { hash, description: null, error };
  return { hash, description };
}

async function processPage(
  page: ExtractedPage,
  cache: SessionImageCache,
  counters: PipelineResult["stats"],
  describeFn: DescribeFn | undefined,
): Promise<{ items: PipelineItem[]; warnings: PipelineWarning[] }> {
  const items: PipelineItem[] = [];
  const warnings: PipelineWarning[] = [];

  // ---- Native text ----
  if (page.text.trim() !== "") {
    items.push({ page: page.page, sourceType: "text", text: page.text });
  }

  // ---- OCR + rendered-page vision ----
  // pdf-extract renders the page whenever it is thin OR has embedded
  // rasters; either way we attempt OCR and vision here.
  if (page.pagePng) {
    let ocrText = "";
    try {
      ocrText = await ocrImage(page.pagePng);
    } catch (err) {
      warnings.push({
        page: page.page,
        stage: "ocr",
        message: err instanceof Error ? err.message : String(err),
      });
      console.warn(`[pipeline] page ${page.page} OCR failed`, err);
    }
    if (ocrText.trim() !== "") {
      items.push({
        page: page.page,
        sourceType: "ocr",
        text: ocrText.trim(),
      });
      counters.ocrPages += 1;
    }
    try {
      const pageDesc = await describeRenderedPage(page.pagePng, describeFn);
      if (pageDesc.trim() !== "") {
        counters.describedImages += 1;
        items.push({
          page: page.page,
          sourceType: "image_description",
          text: `[Rendered page ${page.page}] ${pageDesc.trim()}`,
        });
      }
    } catch (err) {
      const ve =
        err instanceof VisionError
          ? err
          : new VisionError(
              `[pipeline] page ${page.page} page-vision failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
              { provider: "unknown", model: "unknown", cause: err },
            );
      warnings.push({
        page: page.page,
        stage: "page-vision",
        message: ve.message,
      });
      console.warn(`[pipeline] page ${page.page} page-vision failed`, ve.message);
    }
  }

  // ---- Embedded images ----
  for (const png of page.embedded) {
    counters.embeddedImages += 1;
    const res = await describeAndMaybeHash(png, page.page, cache, describeFn);
    if ("error" in res) {
      warnings.push({
        page: page.page,
        stage: "image-vision",
        message: res.error.message,
      });
      console.warn(
        `[pipeline] page ${page.page} image-vision failed`,
        res.error.message,
      );
      continue;
    }
    if (res.description === null) {
      console.log(
        `[pipeline] page ${page.page} image skipped (too small or none)`,
      );
      continue;
    }
    const isFirstTime = cache.size() === 0 || res.hash !== "";
    console.log(
      `[pipeline] page ${page.page} embedded image described ` +
        `hash=${res.hash.slice(0, 12)}… bytes=${png.byteLength}`,
    );
    counters.describedImages += 1;
    items.push({
      page: page.page,
      sourceType: "image_description",
      text: `[Embedded image on page ${page.page}] ${res.description}`,
      imageHash: res.hash,
    });
    // suppress unused-var lint when dedup count is not otherwise used
    void isFirstTime;
  }
  return { items, warnings };
}

export async function runPipeline(
  buf: Uint8Array,
  describeFn?: DescribeFn,
): Promise<PipelineResult> {
  const pages = await extractDocument(buf);
  const cache = new SessionImageCache();
  const counters: PipelineResult["stats"] = {
    pages: pages.length,
    textPages: 0,
    renderedPages: 0,
    embeddedImages: 0,
    describedImages: 0,
    ocrPages: 0,
    failedPages: 0,
  };
  const items: PipelineItem[] = [];
  const warnings: PipelineWarning[] = [];
  for (const p of pages) {
    counters.renderedPages += p.pagePng ? 1 : 0;
    if (p.text.trim() !== "") counters.textPages += 1;
    const out = await processPage(p, cache, counters, describeFn);
    items.push(...out.items);
    warnings.push(...out.warnings);
    if (
      out.warnings.some(
        (w) => w.stage === "page-vision" || w.stage === "image-vision",
      )
    ) {
      counters.failedPages += 1;
    }
  }
  console.log(
    `[pipeline] done pages=${counters.pages} rendered=${counters.renderedPages} ` +
      `text=${counters.textPages} ocr=${counters.ocrPages} ` +
      `embedded=${counters.embeddedImages} described=${counters.describedImages} ` +
      `warnings=${warnings.length}`,
  );
  return { items, warnings, stats: counters };
}