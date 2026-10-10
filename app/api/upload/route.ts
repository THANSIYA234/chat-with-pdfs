/**
 * POST /api/upload — parse, chunk, and embed an uploaded PDF.
 *
 * Pipeline: validate form-data → parse via unpdf → chunk via
 * `chunkPages` → batched embedding via OpenRouter → persist to the
 * Supabase `sessions` + `chunks` tables, keyed by a fresh UUIDv4 id.
 *
 * Cache: `cacheComponents` (Next 16) keeps this per-request. The
 * legacy `export const dynamic = "force-dynamic"` is intentionally
 * omitted; the route is uncached by nature.
 */
import { NextResponse } from "next/server";

import { getDocumentProxy } from "unpdf";

import { chunkPages } from "@/lib/chunk";
import { embedDocuments } from "@/lib/embed";
import { createSession } from "@/lib/store";

const MAX_BYTES = 50 * 1024 * 1024;
const EMBED_BATCH_SIZE = 64;

interface UploadSuccess {
  sessionId: string;
  documentName: string;
  numChunks: number;
  numPages: number;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const form = await req.formData();
    const entry = form.get("file");
    if (!(entry instanceof File)) {
      return NextResponse.json(
        { error: "bad_request", message: 'Missing "file" form field.' },
        { status: 400 },
      );
    }
    const file = entry;
    if (file.size === 0) {
      return NextResponse.json(
        { error: "bad_request", message: "Uploaded file is empty." },
        { status: 400 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "bad_request", message: "File exceeds the 50 MB upload limit." },
        { status: 400 },
      );
    }
    const isPdfType = file.type === "application/pdf";
    const isPdfName = file.name.toLowerCase().endsWith(".pdf");
    if (!isPdfType && !isPdfName) {
      return NextResponse.json(
        {
          error: "bad_request",
          message: "File must be a PDF (application/pdf or .pdf).",
        },
        { status: 400 },
      );
    }

    const buf = new Uint8Array(await file.arrayBuffer());
    const pdf = await getDocumentProxy(buf);

    const pages: { page: number; text: string }[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const { items } = await page.getTextContent();
      const text = items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .trim();
      if (text) {
        pages.push({ page: i, text });
      }
    }

    const chunks = chunkPages(file.name, pages);

    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const vectors = await embedDocuments(batch.map((c) => c.content));
      for (const v of vectors) embeddings.push(v);
    }

    const sessionId = await createSession({
      documentName: file.name,
      chunks,
      embeddings,
    });

    const body: UploadSuccess = {
      sessionId,
      documentName: file.name,
      numChunks: chunks.length,
      numPages: pages.length,
    };
    return NextResponse.json(body, { status: 201 });
  } catch (err) {
    console.error("[upload]", err);
    return NextResponse.json(
      {
        error: "upload_failed",
        message: String((err as { message?: unknown })?.message ?? err),
      },
      { status: 400 },
    );
  }
}