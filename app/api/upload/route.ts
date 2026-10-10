/**
 * POST /api/upload — parse, chunk, and embed an uploaded PDF.
 *
 * Pipeline:
 *   1. Validate form-data + 50 MB cap.
 *   2. `runPipeline(buf)` — text + page renders + embedded images.
 *      Each page contributes paragraphs tagged with a `source_type`
 *      (`text` / `ocr` / `image_description`).
 *   3. `chunkPages(...)` — paragraph-aware ~400-word chunks, page metadata
 *      + `source_type` + `image_hash` passed through unchanged.
 *   4. `embedDocuments(...)` — batched 64, search_document input type.
 *   5. `createSession(...)` — Supabase insert with the existing FK cascade.
 *
 * Cache: `cacheComponents` (Next 16) keeps this per-request. The
 * legacy `export const dynamic = "force-dynamic"` is intentionally
 * omitted; the route is uncached by nature.
 */
import { NextResponse } from "next/server";

import { chunkPages, type ChunkPageInput } from "@/lib/chunk";
import { embedDocuments } from "@/lib/embed";
import { runPipeline, type PipelineItem, type PipelineResult } from "@/lib/pipeline";
import { createSession } from "@/lib/store";

const MAX_BYTES = 50 * 1024 * 1024;
const EMBED_BATCH_SIZE = 64;

interface UploadSuccess {
  sessionId: string;
  documentName: string;
  numChunks: number;
  numPages: number;
  pipeline: PipelineResult["stats"];
  /** Non-fatal issues surfaced to the client (e.g. vision failures). */
  warnings: PipelineResult["warnings"];
}

interface ErrorBody {
  error: string;
  message: string;
}

function badRequest(message: string): Response {
  const body: ErrorBody = { error: "bad_request", message };
  return NextResponse.json(body, { status: 400 });
}

function pipelineItemToPage(p: PipelineItem): ChunkPageInput {
  return {
    page: p.page,
    text: p.text,
    source_type: p.sourceType,
    image_hash: p.imageHash,
  };
}

export async function POST(req: Request): Promise<Response> {
  let file: File;
  try {
    const form = await req.formData();
    const entry = form.get("file");
    if (!(entry instanceof File)) {
      return badRequest('Missing "file" form field.');
    }
    file = entry;
  } catch {
    return badRequest("Could not parse multipart form-data.");
  }

  if (file.size === 0) return badRequest("Uploaded file is empty.");
  if (file.size > MAX_BYTES) return badRequest("File exceeds the 50 MB upload limit.");
  const isPdfType = file.type === "application/pdf";
  const isPdfName = file.name.toLowerCase().endsWith(".pdf");
  if (!isPdfType && !isPdfName) {
    return badRequest("File must be a PDF (application/pdf or .pdf).");
  }

  let buf: Uint8Array;
  try {
    buf = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    return badRequest(
      `Could not read uploaded file: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
    );
  }

  let pipeline: PipelineResult;
  try {
    pipeline = await runPipeline(buf);
  } catch (err) {
    console.error("[upload] pipeline failed", err);
    const message =
      err instanceof Error ? err.message : "Unknown PDF parsing error.";
    return badRequest(`Failed to parse PDF: ${message}`);
  }

  if (pipeline.items.length === 0) {
    return badRequest(
      "PDF had no extractable content (text, images, or OCR).",
    );
  }

  const pages: ChunkPageInput[] = pipeline.items.map(pipelineItemToPage);
  const chunks = chunkPages(file.name, pages);

  if (chunks.length === 0) {
    return badRequest(
      "PDF produced no chunks — every page was below the chunk size threshold.",
    );
  }

  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    let vectors: number[][];
    try {
      vectors = await embedDocuments(batch.map((c) => c.content));
    } catch (err) {
      console.error("[upload] embedding failed", err);
      const message =
        err instanceof Error ? err.message : "Unknown embedding error.";
      return NextResponse.json(
        { error: "upload_failed", message: `Embedding failed: ${message}` },
        { status: 502 },
      );
    }
    for (const v of vectors) embeddings.push(v);
  }

  let sessionId: string;
  try {
    sessionId = await createSession({
      documentName: file.name,
      chunks,
      embeddings,
    });
  } catch (err) {
    console.error("[upload] createSession failed", err);
    const message =
      err instanceof Error ? err.message : "Unknown storage error.";
    return NextResponse.json(
      { error: "upload_failed", message: `Storage failed: ${message}` },
      { status: 502 },
    );
  }

  const body: UploadSuccess = {
    sessionId,
    documentName: file.name,
    numChunks: chunks.length,
    numPages: pipeline.stats.pages,
    pipeline: pipeline.stats,
    warnings: pipeline.warnings,
  };
  return NextResponse.json(body, { status: 201 });
}
