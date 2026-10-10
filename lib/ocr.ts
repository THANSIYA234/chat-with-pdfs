/**
 * Tesseract.js OCR wrapper.
 *
 * The wasm-based Tesseract worker is heavy to spin up (tens of ms cold,
 * ~100 MB RSS). We keep at most one live worker per (lang) and reuse it
 * for the entire upload. On any failure we degrade gracefully — return
 * an empty string and warn — so OCR never blocks the pipeline.
 *
 * Worker instances are managed per-process via a module-scoped map. We
 * explicitly `terminate()` on unload (process exit) and when a stale
 * language set is requested.
 */
import { createWorker, type Worker } from "tesseract.js";

import { env } from "@/lib/env";

type OcrRecord = {
  lang: string;
  worker: Worker;
};

let current: OcrRecord | null = null;

function buildWorker(lang: string): Promise<OcrRecord> {
  return createWorker(lang === "eng" ? ["eng"] : lang.split("+"), 1, {
    logger: () => {
      /* silent — too noisy during PDF ingestion */
    },
  }).then((worker) => ({ lang, worker }));
}

async function getWorker(): Promise<OcrRecord | null> {
  if (!env.ENABLE_OCR) return null;
  const lang = env.OCR_LANG;
  if (current && current.lang === lang) return current;
  if (current) {
    try {
      await current.worker.terminate();
    } catch {
      /* swallow */
    }
    current = null;
  }
  try {
    current = await buildWorker(lang);
    return current;
  } catch (err) {
    console.warn("[ocr] worker init failed", err);
    return null;
  }
}

/**
 * Run OCR over a PNG/JPEG buffer. Returns the recovered text trimmed
 * and lowercased-untouched (caller decides), or "" on any failure.
 *
 * Always swallows errors and logs a warning so OCR problems never
 * fail an upload.
 */
export async function ocrImage(png: Buffer | Uint8Array): Promise<string> {
  const rec = await getWorker();
  if (!rec) return "";
  try {
    const buf: Buffer = Buffer.isBuffer(png) ? png : Buffer.from(png);
    const { data } = await rec.worker.recognize(buf);
    return (data?.text ?? "").trim();
  } catch (err) {
    console.warn("[ocr] recognize failed", err);
    return "";
  }
}

/**
 * Best-effort cleanup. Not strictly necessary — the OS reclaims
 * everything on process exit — but useful in long-running dev servers.
 */
export async function shutdownOcr(): Promise<void> {
  if (!current) return;
  try {
    await current.worker.terminate();
  } catch {
    /* ignore */
  }
  current = null;
}
