# Chat with your PDF

Upload a PDF, ask questions about it, and get a short cited answer drawn from that one document. If the answer is not in the PDF, the app responds with the literal string `I couldn't find that in this PDF.` State is per-session in Supabase (session record + chunked embedding rows), with a 1-hour idle TTL — closing the tab or waiting past the expiry makes the document forgettable.

## Stack

- Next.js 16 App Router, React 19
- MiniMax-M3 (`https://api.minimax.io/v1/chat/completions`, OpenAI-compatible) for the cited answer
- OpenRouter embeddings (`openai/text-embedding-3-small` at 1536 dims)
- Supabase Postgres + pgvector for per-session chunk storage and cosine-similarity retrieval
- In-memory per-IP rate limiter (`lib/ratelimit.ts`)

## How it works

- **Upload** — `POST /api/upload` accepts the PDF (≤50 MB) as multipart form-data.
- **Parse** — pages and text are extracted in the route with `unpdf`.
- **Chunk** — paragraphs with overlap, ~400 words per chunk (`lib/chunk.ts`).
- **Embed** — vectors are produced by OpenRouter in batches of 64 (`lib/embed.ts`).
- **Persist** — `createSession` (`lib/store.ts`) inserts one row into `sessions` and bulk-inserts the chunk rows into `chunks` with `embedding vector(1536)`. Returns a UUID `sessionId`. A 100-session cap evicts the least-recently-used rows on overflow.
- **Ask** — `POST /api/ask` takes `{ sessionId, question }`, bumps the session's `last_accessed_at` + `expires_at`, rate-limits by IP, then embeds the question.
- **Retrieve** — `lib/retrieve.ts` calls the `match_chunks` RPC with `query_embedding`, `filter_session_id`, and `match_count=5`; pgvector returns the top-5 chunks for that session ordered by cosine distance.
- **Generate** — MiniMax-M3 receives the top chunks inlined as numbered sources `[1]…[5]`, followed by the question; the model answers in plain text and marks each factual claim with `[n]`. If the answer is not in the sources, it returns the literal refusal string.
- **Return** — `{ answer, citations }` with one chip per cited page.

## Database setup

Run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL editor (Project → SQL → New query → paste → Run). It creates the `vector` extension, the `sessions` and `chunks` tables (FK with `ON DELETE CASCADE`), indexes for the cleanup and retrieval paths, and the `match_chunks` RPC. The service-role key bypasses RLS for these server-side writes.

## Environment variables

See [`.env.example`](.env.example). The four required keys are validated lazily — `lib/env.ts` throws a labeled error listing any that are missing on first property access. The three model overrides are optional and default to the values shown.

Required:

- `OPENROUTER_API_KEY` — Auth for the embedding model.
- `MINIMAX_API_KEY` — Auth for the cited-answer call (https://api.minimax.io → API keys).
- `SUPABASE_URL` — Supabase project URL (Project Settings → API).
- `SUPABASE_SERVICE_ROLE_KEY` — Service-role key (server-only; never expose to the browser).

Optional:

- `EMBED_MODEL` — Defaults to `openai/text-embedding-3-small`.
- `EMBED_DIMS` — Defaults to `1536`; the `chunks.embedding` column is `vector(1536)` — re-run the schema if you change it.
- `MINIMAX_BASE_URL` — Defaults to `https://api.minimax.io/v1`.
- `MINIMAX_MODEL` — Defaults to `MiniMax-M3`.

## Local development

```bash
pnpm install
cp .env.example .env.local
# fill in OPENROUTER_API_KEY, MINIMAX_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
# then run the SQL in supabase/schema.sql against the project
pnpm dev
```

Open `http://localhost:3000`. No scripts to run.

## Limits

- 50 MB upload cap (`app/api/upload/route.ts`).
- 1-hour session TTL — bumped to a fresh hour on every successful `getSession` (`lib/store.ts`, `SESSION_TTL_MS`).
- 100-session cap, LRU by `last_accessed_at` (`lib/store.ts`).
- 20 questions/hour per IP (`lib/ratelimit.ts`, applied in `app/api/ask/route.ts`).

## Deploy to Vercel

1. Push the repo to GitHub.
2. Import the repo in Vercel.
3. Run `supabase/schema.sql` against the production Supabase project.
4. In the Vercel project settings, set these four env vars on the Production environment:
   - `OPENROUTER_API_KEY`
   - `MINIMAX_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
5. Trigger a deploy.

## Chip URL pattern

Citations link to `blob:#<n>`; the browser's native PDF viewer reads the fragment and jumps to the cited page on the user's own uploaded blob.

## Project layout

- `app/` — Next.js App Router routes; `app/page.tsx`, `app/layout.tsx`, and the `api/ask`, `api/upload`, `api/health` handlers.
- `components/` — `Chat.tsx` upload + chat client component.
- `lib/` — `env.ts`, `chunk.ts`, `embed.ts`, `store.ts`, `retrieve.ts`, `ratelimit.ts`.
- `supabase/` — `schema.sql` (paste into the Supabase SQL editor).

## Guarantee

If the answer is not in the uploaded PDF, the app responds with the literal string `I couldn't find that in this PDF.` — no outside knowledge.

---

The previous build spec is at [`../CHAT_WITH_PDFS_PLAN.md`](../CHAT_WITH_PDFS_PLAN.md).
