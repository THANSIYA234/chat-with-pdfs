/**
 * Session-filtered pgvector retrieval.
 *
 * Embeds the user question via `embedQuery`, then calls the
 * `match_chunks` RPC which does cosine-similarity search restricted to
 * one `session_id`. Returns the top `k` chunks in similarity order.
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

export type RankedChunk = {
  document: string;
  page: number;
  chunk_index: number;
  content: string;
  similarity: number;
};

interface MatchChunksRow {
  id: number;
  document: string;
  page: number;
  chunk_index: number;
  content: string;
  similarity: number;
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
  return rows.map((r) => ({
    document: r.document,
    page: r.page,
    chunk_index: r.chunk_index,
    content: r.content,
    similarity: r.similarity,
  }));
}