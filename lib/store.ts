/**
 * Supabase-backed per-session store for upload-based ephemeral RAG.
 *
 * Each session owns the chunked + embedded representation of a single
 * uploaded PDF, persisted to Postgres with a `pgvector` column for the
 * embeddings. Sessions expire on idle (TTL bumped on each read) or on
 * global overflow (LRU by `last_accessed_at`). Cleanup of expired rows
 * happens opportunistically on every `createSession`.
 *
 * Uses the Supabase service-role key so RLS is bypassed on the server.
 *
 * The Supabase client is constructed lazily so `next build` can import
 * this module without env vars set; the `env` Proxy only validates on
 * first read.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";

export interface Chunk {
  document: string;
  page: number;
  chunk_index: number;
  content: string;
}

export interface SessionData {
  documentName: string;
  createdAt: Date;
  lastAccessedAt: Date;
  expiresAt: Date;
}

const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 100;

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

/**
 * Drop any sessions whose `expires_at` has already passed. Best-effort:
 * `count` is informational and a failure here is swallowed so it never
 * blocks an upload.
 */
async function evictExpired(): Promise<number | null> {
  const { count, error } = await client()
    .from("sessions")
    .delete({ count: "exact" })
    .lte("expires_at", new Date().toISOString());
  if (error) {
    console.warn("[store] evictExpired failed", error.message);
    return null;
  }
  return count ?? 0;
}

async function activeSessionCount(): Promise<number> {
  const { count, error } = await client()
    .from("sessions")
    .select("id", { count: "exact", head: true });
  if (error) {
    console.warn("[store] activeSessionCount failed", error.message);
    return 0;
  }
  return count ?? 0;
}

/**
 * If we are at or above `MAX_SESSIONS`, delete the least-recently-used
 * rows until we are back under the cap. Uses the `evict_oldest_sessions`
 * RPC defined in `supabase/schema.sql`.
 */
async function evictToCap(): Promise<void> {
  const count = await activeSessionCount();
  if (count < MAX_SESSIONS) return;
  const overflow = count - MAX_SESSIONS + 1;
  const { error } = await client().rpc("evict_oldest_sessions", {
    n: overflow,
  });
  if (error) {
    console.warn("[store] evictToCap failed", error.message);
  }
}

/**
 * Create a new session for an uploaded PDF.
 *
 * - Generates a UUIDv4 id via `crypto.randomUUID()`.
 * - Evicts expired rows opportunistically so the table doesn't grow
 *   without bound across deploys.
 * - Caps the active session count at `MAX_SESSIONS` (LRU by
 *   `last_accessed_at`).
 * - Bulk-inserts chunks with their embeddings as Postgres `vector`
 *   literals (string form `[0.1,0.2,...]` is what pgvector accepts).
 */
export async function createSession(data: {
  documentName: string;
  chunks: Chunk[];
  embeddings: number[][];
}): Promise<string> {
  if (data.chunks.length !== data.embeddings.length) {
    throw new Error(
      `[store] createSession: chunks (${data.chunks.length}) and embeddings (${data.embeddings.length}) length mismatch`,
    );
  }

  await evictExpired();
  await evictToCap();

  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  const { error: sessionErr } = await client()
    .from("sessions")
    .insert({
      id,
      document_name: data.documentName,
      created_at: now.toISOString(),
      last_accessed_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
  if (sessionErr) {
    throw new Error(`[store] insert session failed: ${sessionErr.message}`);
  }

  if (data.chunks.length === 0) return id;

  const rows = data.chunks.map((c, i) => ({
    session_id: id,
    document: c.document,
    page: c.page,
    chunk_index: c.chunk_index,
    content: c.content,
    // pgvector accepts the literal-string form via PostgREST; `JSON.stringify`
    // yields exactly the `[0.1,0.2,…]` shape we need.
    embedding: JSON.stringify(data.embeddings[i]!),
  }));

  const { error: chunksErr } = await client().from("chunks").insert(rows);
  if (chunksErr) {
    // Roll back the orphan session row so we don't leak storage.
    await client().from("sessions").delete().eq("id", id);
    throw new Error(`[store] insert chunks failed: ${chunksErr.message}`);
  }

  return id;
}

interface SessionRow {
  id: string;
  document_name: string;
  created_at: string;
  last_accessed_at: string;
  expires_at: string;
}

function rowToSessionData(row: SessionRow): SessionData {
  return {
    documentName: row.document_name,
    createdAt: new Date(row.created_at),
    lastAccessedAt: new Date(row.last_accessed_at),
    expiresAt: new Date(row.expires_at),
  };
}

/**
 * Retrieve a session by id and bump its TTL. Returns `undefined` when
 * the id is unknown or the session has already expired.
 *
 * Implemented as `update … where id = $1 and expires_at > now()
 * returning *` so the bump + read is atomic and we don't have to
 * second-guess a TTL window between read and write.
 */
export async function getSession(
  id: string,
): Promise<SessionData | undefined> {
  const now = new Date();
  const newExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  const { data, error } = await client()
    .from("sessions")
    .update({
      last_accessed_at: now.toISOString(),
      expires_at: newExpiresAt.toISOString(),
    })
    .eq("id", id)
    .gt("expires_at", now.toISOString())
    .select("id, document_name, created_at, last_accessed_at, expires_at")
    .maybeSingle();

  if (error) {
    throw new Error(`[store] getSession failed: ${error.message}`);
  }
  if (!data) return undefined;
  return rowToSessionData(data as SessionRow);
}

/**
 * Delete a session by id (chunks go with it). Returns `true` if the row
 * existed, else `false`.
 */
export async function deleteSession(id: string): Promise<boolean> {
  const { count, error } = await client()
    .from("sessions")
    .delete({ count: "exact" })
    .eq("id", id);
  if (error) {
    throw new Error(`[store] deleteSession failed: ${error.message}`);
  }
  return (count ?? 0) > 0;
}