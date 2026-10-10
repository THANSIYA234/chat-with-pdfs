/**
 * Session-filtered pgvector retrieval.
 *
 * Embeds the user question via `embedQuery`, then calls the
 * `match_chunks` RPC which does cosine-similarity search restricted to
 * one `session_id`. Returns the top `k` chunks in similarity order.
 *
 * Visual-content boost: when the question mentions visible objects,
 * labels, diagrams, charts, or photos, image_description chunks are
 * re-ranked higher than their raw similarity score would otherwise
 * warrant. The boost is a constant additive term, not a multiplier,
 * so the existing pgvector ordering still dominates when no image
 * description is present.
 *
 * The Supabase client is constructed lazily so `next build` can import
 * this module without env vars set.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";
import { embedQuery } from "@/lib/embed";

let cachedClient: SupabaseClient | null = null;
function client(): SupabaseClient {
  if (!cachedClient) {
    cachedClient = createClient(
      env.SUPABASE_URL,
      env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return cachedClient;
}

export type SourceType = "text" | "ocr" | "image_description";

export type RankedChunk = {
  document: string;
  page: number;
  chunk_index: number;
  content: string;
  similarity: number;
  source_type: SourceType;
  image_hash: string | null;
};

interface MatchChunksRow {
  id: number;
  document: string;
  page: number;
  chunk_index: number;
  content: string;
  similarity: number;
  source_type: SourceType;
  image_hash: string | null;
}

/**
 * Additive boost applied to `similarity` for image_description chunks
 * when the question looks visual. Picked so a *borderline* match on an
 * image description (similarity ≈ 0.45) climbs into the top-k even when
 * a strong text match (≈ 0.85) is also present — but a *strong* image
 * match (≈ 0.80) still beats a mid text match.
 */
const VISUAL_BOOST = 0.25;

const VISUAL_KEYWORDS = [
  "image",
  "images",
  "picture",
  "pictures",
  "photo",
  "photos",
  "photograph",
  "photographs",
  "diagram",
  "diagrams",
  "chart",
  "charts",
  "graph",
  "graphs",
  "plot",
  "plots",
  "figure",
  "figures",
  "label",
  "labels",
  "labeled",
  "labelled",
  "logo",
  "logos",
  "illustration",
  "illustrations",
  "icon",
  "icons",
  "shown",
  "show",
  "showed",
  "see",
  "seen",
  "look",
  "looks",
  "looking",
  "appear",
  "appears",
  "visible",
  "visually",
  "display",
  "displays",
  "displayed",
  "depict",
  "depicts",
  "depicted",
  "scene",
  "cover",
  "covers",
  "packaging",
  "box",
  "inside",
  "contains",
  "what's inside",
  "what is inside",
  "what is shown",
  "what does it show",
  "describe the image",
  "describe the picture",
];

/** Heuristic: does the question ask about visible / pictured content? */
export function isVisualQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return VISUAL_KEYWORDS.some((kw) => {
    if (kw.includes(" ")) return q.includes(kw);
    // Match whole words only for short keywords to avoid "see" matching "seem".
    return new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(q);
  });
}

export async function search(
  question: string,
  sessionId: string,
  k: number = 5,
): Promise<RankedChunk[]> {
  const q = await embedQuery(question);

  const { data, error } = await client().rpc("match_chunks", {
    query_embedding: JSON.stringify(q),
    filter_session_id: sessionId,
    match_count: k,
  });

  if (error) {
    throw new Error(`[retrieve] match_chunks failed: ${error.message}`);
  }

  const rows = (data ?? []) as MatchChunksRow[];
  const ranked: RankedChunk[] = rows.map((r) => ({
    document: r.document,
    page: r.page,
    chunk_index: r.chunk_index,
    content: r.content,
    similarity: r.similarity,
    source_type: r.source_type,
    image_hash: r.image_hash,
  }));

  if (!isVisualQuestion(question)) return ranked;

  // Two-pass retrieval for visual questions: fetch a wider candidate
  // pool, apply the boost, and re-rank. Doubles the row count we touch
  // but keeps the same RPC + same index path.
  const expanded = Math.max(k * 4, 12);
  if (expanded <= k) return boostAndRank(ranked);

  const { data: widerData, error: widerErr } = await client().rpc("match_chunks", {
    query_embedding: JSON.stringify(q),
    filter_session_id: sessionId,
    match_count: expanded,
  });
  if (widerErr) {
    // Boost what we already have; never let an RPC glitch kill the answer.
    console.warn("[retrieve] wider match failed, falling back", widerErr.message);
    return boostAndRank(ranked);
  }
  const wider = (widerData ?? []) as MatchChunksRow[];
  const widerRanked: RankedChunk[] = wider.map((r) => ({
    document: r.document,
    page: r.page,
    chunk_index: r.chunk_index,
    content: r.content,
    similarity: r.similarity,
    source_type: r.source_type,
    image_hash: r.image_hash,
  }));
  return boostAndRank(widerRanked).slice(0, k);
}

function boostAndRank(rows: RankedChunk[]): RankedChunk[] {
  // Dedupe by (document, page, chunk_index) keeping the highest boosted
  // score, then sort descending.
  const byKey = new Map<string, RankedChunk & { boosted: number }>();
  for (const r of rows) {
    const key = `${r.document}\u0000${r.page}\u0000${r.chunk_index}`;
    const boosted =
      r.similarity + (r.source_type === "image_description" ? VISUAL_BOOST : 0);
    const existing = byKey.get(key);
    if (!existing || existing.boosted < boosted) {
      byKey.set(key, { ...r, boosted });
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.boosted - a.boosted)
    .map(({ boosted: _boosted, ...rest }) => {
      void _boosted;
      return rest;
    });
}