/**
 * POST /api/ask — answer a question against an uploaded PDF session.
 *
 * 1. Validate body (`sessionId` + `question`).
 * 2. Per-IP rate limit (`x-forwarded-for` first hop, else `"anon"`).
 * 3. Look up the Supabase session (bumps TTL atomically; missing or
 *    expired → 404).
 * 4. Embed the query, run session-filtered pgvector search via
 *    `lib/retrieve.ts`, take the top 5.
 * 5. Inline the chunks into a single prompt, ask MiniMax-M3 to answer
 *    and cite using `[n]` markers, then parse those markers back to
 *    the originating chunks for snippet/page metadata.
 *
 * Error map:
 *   - rate limit exceeded                  → 429
 *   - session missing or expired           → 404
 *   - upstream timeout (AbortError)        → 504
 *   - upstream HTTP non-2xx                → 502
 *   - anything else                        → 500
 *
 * Cache: `cacheComponents` (Next 16) keeps this per-request; the
 * legacy `export const dynamic = "force-dynamic"` is intentionally
 * omitted.
 */
import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { search, type RankedChunk } from "@/lib/retrieve";
import { getSession } from "@/lib/store";
import { check } from "@/lib/ratelimit";

const SYSTEM =
  `You are a friendly, natural, helpful PDF assistant, like ChatGPT. ` +
  `Answer the user's question directly in clear, conversational language. ` +
  `Never reveal internal reasoning or output <think> tags. ` +
  `Use only the provided numbered sources for factual claims. ` +
  `Explain the answer naturally without describing your internal process. ` +
  `Use short paragraphs or bullet points when helpful. ` +
  `Do not include citation numbers such as [1] or [2] in the final answer text. ` +
  `Use the provided sources to answer accurately. ` +
  `Each source begins with its origin in square brackets: ` +
  `[text] -- extractable PDF text, ` +
  `[ocr] -- text recovered by OCR from a scanned page, or ` +
  `[image_description] -- natural-language description emitted by a ` +
  `vision model of a chart, diagram, photo, scanned element, or ` +
  `embedded image. Image-description sources are the ONLY reliable ` +
  `evidence for visible objects, labels, packaging contents, colors, ` +
  `shapes, and scene descriptions; OCR is unreliable on photos and ` +
  `returns noise characters. ` +
  `When the user asks about a photo, the contents of a box, what a ` +
  `diagram shows, the labels on a product, or any other visible ` +
  `element, prefer image-description sources over text/OCR. ` +
  `If the answer cannot be found in the sources, reply with exactly: ` +
  `I couldn't find that in this PDF. ` +
  `Do not guess or use outside knowledge, and do not invent ` +
  `packaging contents, labels, or values that no source explicitly ` +
  `states. If only OCR noise is available, that is not evidence.`;

const REFUSAL = "I couldn't find that in this PDF.";
const TOP_K = 5;
const REQUEST_TIMEOUT_MS = 25_000;
const SNIPPET_CHARS = 200;

interface CitationOut {
  document: string;
  page: number;
  snippet?: string;
  source_type?: "text" | "ocr" | "image_description";
  image_hash?: string | null;
}

function buildUserPrompt(
  chunks: ReadonlyArray<RankedChunk>,
  question: string,
): string {
  const sources = chunks
    .map((c, i) => `[${i + 1}] (${c.document}, page ${c.page})\n${c.content}`)
    .join("\n\n");
  return `${sources}\n\nQuestion: ${question}`;
}

function parseCitations(
  answer: string,
  chunks: ReadonlyArray<RankedChunk>,
): CitationOut[] {
  // Collect all [n] markers, allow whitespace inside, dedupe by (doc, page).
  const marker = /\[\s*(\d+)\s*\]/g;
  const seen = new Set<string>();
  const out: CitationOut[] = [];
  for (const m of answer.matchAll(marker)) {
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n > chunks.length) continue;
    const ref = chunks[n - 1];
    const key = `${ref.document}\u0000${ref.page}\u0000${ref.source_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      document: ref.document,
      page: ref.page,
      snippet: ref.content.slice(0, SNIPPET_CHARS),
      source_type: ref.source_type,
      image_hash: ref.image_hash,
    });
  }
  return out;
}

interface ChatChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}
interface ChatResponse {
  choices?: ChatChoice[];
  error?: { message?: string; type?: string };
}

async function callMiniMax(prompt: string): Promise<string> {
  const url = `${env.MINIMAX_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.MINIMAX_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.MINIMAX_MODEL,
      temperature: 0,
      max_tokens: 800,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[ask] MiniMax HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as ChatResponse;
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(
      `[ask] MiniMax response missing content: ${data.error?.message ?? "unknown"}`,
    );
  }
  return content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export async function POST(req: Request): Promise<Response> {
  // ---- Body validation ----
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("sessionId" in body) ||
    typeof body.sessionId !== "string" ||
    body.sessionId.trim() === "" ||
    !("question" in body) ||
    typeof body.question !== "string" ||
    body.question.trim() === ""
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const sessionId: string = body.sessionId;
  const question: string = body.question.trim();

  // ---- Rate limit first ----
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const rl = check(ip);
  if (!rl.allowed) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message:
          "You have hit the 20-questions-per-hour limit. Try again later.",
      },
      { status: 429 },
    );
  }

  // ---- Session lookup ----
  const session = await getSession(sessionId);
  if (!session) {
    return NextResponse.json(
      {
        error: "session_not_found",
        message: "Session expired or not found. Re-upload your PDF.",
      },
      { status: 404 },
    );
  }

  // ---- Retrieval: embed query + session-filtered pgvector search ----
  let chunks: RankedChunk[];
  try {
    chunks = await search(question, sessionId, TOP_K);
  } catch (err) {
    console.error("[ask] retrieve failed", err);
    const message = (err as { message?: unknown })?.message ?? String(err);
    return NextResponse.json(
      { error: "internal", message: String(message) },
      { status: 500 },
    );
  }

  // ---- Generate cited answer via MiniMax-M3 ----
  let answer: string;
  try {
    answer = await callMiniMax(buildUserPrompt(chunks, question));
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      return NextResponse.json({ error: "upstream_timeout" }, { status: 504 });
    }
    console.error("[ask] MiniMax call failed", err);
    return NextResponse.json(
      {
        error: "upstream_error",
        message:
          (err as { message?: string })?.message ?? "MiniMax request failed",
      },
      { status: 502 },
    );
  }

  // ---- Refusal path: drop any markers; the model already refused ----
  if (answer.trim() === REFUSAL) {
    return NextResponse.json(
      { answer: REFUSAL, citations: [] },
      { status: 200 },
    );
  }

  return NextResponse.json(
    { answer, citations: parseCitations(answer, chunks) },
    { status: 200 },
  );
}
