# Chat with your PDF

Upload a PDF, ask questions about it, and get a short cited answer drawn from that one document. Scanned pages, charts, diagrams, screenshots, and embedded photos are indexed alongside the native text via OCR + a vision model, so questions like *"what is the chart on page 4 showing?"* or *"explain the workflow on page 7"* return grounded answers with page citations. If the answer is not in the PDF, the app responds with the literal string `I couldn't find that in this PDF.` State is per-session in Supabase (session record + chunked embedding rows), with a 1-hour idle TTL — closing the tab or waiting past the expiry makes the document forgettable.

## Stack

- Next.js 16 App Router, React 19
- MiniMax-M3 (`https://api.minimax.io/v1/chat/completions`, OpenAI-compatible) for the cited answer
- OpenRouter embeddings (`nvidia/nemotron-3-embed-1b:free` at 2048 dims by default)
- OpenRouter Chat Completions with a vision-capable model (default `openai/gpt-4o-mini`), or the same MiniMax-M3 used for the answer (multimodal; selected via `VISION_PROVIDER=minimax`)
- Tesseract.js (WASM, no native deps) for OCR over scanned pages
- `unpdf` (`pdfjs-dist` + `@napi-rs/canvas`) for text extraction, page rendering, and embedded-image extraction
- Supabase Postgres + pgvector for per-session chunk storage and cosine-similarity retrieval
- In-memory per-IP rate limiter (`lib/ratelimit.ts`)

## How it works

### Upload + indexing

- **Upload** — `POST /api/upload` accepts the PDF (≤50 MB) as multipart form-data.
- **Parse** — pages flow through `lib/pdf-extract.ts`:
  - native text via `getTextContent()` per page;
  - every page that is "thin" (< 30 alnum chars) **or** contains any
    embedded raster is rendered to PNG via `pdfjs-dist` (configured by
    `RENDER_DPI`); pages that are text-rich and raster-free skip the
    expensive render step;
  - every embedded raster is extracted and re-encoded as PNG with `sharp`.
- **Index** — `lib/pipeline.ts` walks each page once:
  - native text → `text` chunk;
  - OCR (Tesseract.js) on the rendered page PNG → `ocr` chunk when non-empty;
  - vision model over the rendered page → `image_description` chunk;
  - vision model over each unique (by sha-256) embedded image → `image_description` chunk (de-duped across the session).
  - Vision errors (rate limit, 4xx/5xx, network) are surfaced as
    `warnings` on the upload response — never swallowed silently. The
    pipeline logs the failed stage, page number, and OpenRouter status
    without leaking API keys.
- **Chunk** — paragraphs with overlap, ~400 words per chunk (`lib/chunk.ts`).
  The chunker flushes at every `source_type` boundary so a vision
  description is never silently absorbed into an OCR chunk (which is
  the exact bug that left `IMG_3603.pdf` with a single OCR chunk).
  `source_type` and `image_hash` flow through unchanged.
- **Embed** — vectors are produced by OpenRouter in batches of 64 (`lib/embed.ts`).
- **Persist** — `createSession` (`lib/store.ts`) inserts one row into `sessions`, one row per image into `image_descriptions` (PK `(session_id, image_hash)`), and bulk-inserts the chunk rows into `chunks`. Returns a UUID `sessionId`. A 100-session cap evicts the least-recently-used rows on overflow.

### Ask

- **Ask** — `POST /api/ask` takes `{ sessionId, question }`, bumps the session's `last_accessed_at` + `expires_at`, rate-limits by IP, then embeds the question.
- **Retrieve** — `lib/retrieve.ts` calls the `match_chunks` RPC with `query_embedding`, `filter_session_id`, and `match_count=5`; pgvector returns the top-5 chunks for that session ordered by cosine distance (now including `source_type` and `image_hash`). When the question mentions visible content (photos, boxes, diagrams, charts, "what is inside", etc.) `isVisualQuestion` widens the candidate pool and applies a +0.25 additive boost to `image_description` chunks so a borderline match on a photo description outranks a strong text match.
- **Generate** — MiniMax-M3 receives the top chunks inlined as numbered sources `[1]…[5]`, followed by the question; the model answers in plain text and marks each factual claim with `[n]`. Each source carries a `Source: text|ocr|image_description` tag and the system prompt explicitly tells the model to ground visible-object claims in `image_description` sources, not in OCR noise, and never to invent packaging contents. If the answer is not in the sources, it returns the literal refusal string.
- **Return** — `{ answer, citations }` with one chip per cited page; each chip is labeled `t` / `o` / `i` so the user can tell which citation came from text, OCR, or an image description.

## Database setup

Run [`supabase/schema.sql`](supabase/schema.sql) in the Supabase SQL editor (Project → SQL → New query → paste → Run). It creates the `vector` extension, the `sessions`, `chunks`, and `image_descriptions` tables (FK with `ON DELETE CASCADE`), indexes for the cleanup and retrieval paths, and the `match_chunks` RPC. The `chunks` table is migrated in-place to add the `source_type` + `image_hash` columns and the `match_chunks` RPC is recreated to expose them. The service-role key bypasses RLS for these server-side writes.

## Environment variables

See [`.env.example`](.env.example). The four required keys are validated lazily — `lib/env.ts` throws a labeled error listing any that are missing on first property access. All other variables are optional and use the defaults shown below.

Required:

- `OPENROUTER_API_KEY` — Auth for embeddings and vision-model calls.
- `MINIMAX_API_KEY` — Auth for the cited-answer call (https://api.minimax.io → API keys).
- `SUPABASE_URL` — Supabase project URL (Project Settings → API).
- `SUPABASE_SERVICE_ROLE_KEY` — Service-role key (server-only; never expose to the browser).

Optional — embeddings + answer:

- `EMBED_MODEL` — Defaults to `openai/text-embedding-3-small`. The
  project also works with `nvidia/nemotron-3-embed-1b:free` (2048 dims).
- `EMBED_DIMS` — Defaults to `2048`; the `chunks.embedding` column is
  `vector(2048)`. **Never** silently truncate — if you change dims,
  follow the manual resize recipe in `supabase/schema.sql` so existing
  rows are re-embedded instead of dropped.
- `MINIMAX_BASE_URL` — Defaults to `https://api.minimax.io/v1`.
- `MINIMAX_MODEL` — Defaults to `MiniMax-M3`.

Optional — image pipeline:

- `VISION_PROVIDER` — `"minimax"` (default, recommended) or `"openrouter"`.
  `"minimax"` reuses the existing `MINIMAX_API_KEY` against `MINIMAX_BASE_URL`
  with `MINIMAX_MODEL` (MiniMax-M3 is multimodal), so no OpenRouter credits
  are needed for image understanding. `"openrouter"` routes the call
  through OpenRouter with `VISION_MODEL`; only use this if you have
  OpenRouter credits and need a specific vision-capable model.
- `VISION_MODEL` — OpenRouter model id used to describe rendered pages
  + embedded images when `VISION_PROVIDER=openrouter`. Defaults to
  `openai/gpt-4o-mini`. **Must** accept image input and **must** be
  reachable with your OpenRouter credits; free Gemini vision tiers
  were retired in 2026 and OpenRouter returns `402 Payment Required`
  for unfunded accounts. The pipeline surfaces those errors as
  `warnings` on the upload response — it never silently substitutes
  OCR garbage as a fake image description.
- `OCR_LANG` — Tesseract.js language pack, e.g. `eng` or `eng+fra`. Defaults to `eng`.
- `MAX_IMAGE_PIXELS` — Largest side of any image fed to OCR / vision; larger inputs are downscaled. Defaults to `1280`.
- `RENDER_DPI` — Render scale used by `unpdf`; `1.0 ≈ 72 dpi`, `2.0 ≈ 144 dpi`. Defaults to `2`.
- `ENABLE_OCR` — Set `false` / `0` to skip OCR entirely.
- `ENABLE_VISION` — Set `false` / `0` to skip vision-model calls.

### Image / OCR / Vision pipeline behaviour

- **Pages with no extractable text** are still rendered and described —
  a photograph of a product box (`IMG_3603.pdf`) flows through OCR + a
  full-page vision description + per-image vision descriptions.
- **Vision errors are loud.** Any HTTP failure, parse error, or
  transient 429/5xx from OpenRouter is retried with exponential
  backoff up to 3 attempts; if it still fails the error is recorded
  on the upload response (`warnings[]`) with the stage, page number,
  and the upstream status. They are never silently swallowed.
- **Visual questions are boosted.** When the question mentions a
  photo, box contents, diagrams, charts, labels, or "what is inside",
  `lib/retrieve.ts` widens the candidate pool and applies a +0.25
  additive boost to `image_description` chunks.

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
- Page rendering + OCR + vision calls run sequentially per page so we never pile up workers; for 100+ page PDFs the bottleneck is usually the vision model. Drop `RENDER_DPI` to `1` and `MAX_IMAGE_PIXELS` to `768` to cut time/cost roughly in half at the cost of slightly less legible OCR.

## Regression tests

Two scripts under `scripts/`:

- `pnpm fixtures` — re-build the five test PDFs (`text-only.pdf`, `scanned.pdf`, `embedded.pdf`, `chart.pdf`, `box.pdf`) into `scripts/fixtures/`.
- `pnpm test:pipeline` — extraction-only smoke test with `ENABLE_VISION=false`; verifies the chunk counts per fixture.
- `pnpm tsx scripts/test-vision-pipeline.mts` — end-to-end vision test using a `DescribeFn` stub. Asserts that `box.pdf` (a single-page photo, structurally identical to `IMG_3603.pdf`) produces `image_description` chunks that contain the trimmer, Type-C charging cable, cleaning brush, and 2 beard combs, that `isVisualQuestion("What is inside the box?")` is true, and that the visual boost re-ranks image chunks above zero text.

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

Citations link to `blob:#<n>`; the browser's native PDF viewer reads the fragment and jumps to the cited page on the user's own uploaded blob. Each chip carries a small `t` / `o` / `i` tag so the user can tell whether the citation came from native text, OCR, or an image description.

## Project layout

- `app/` — Next.js App Router routes; `app/page.tsx`, `app/layout.tsx`, and the `api/ask`, `api/upload`, `api/health` handlers.
- `components/` — `Chat.tsx` upload + chat client component.
- `lib/` — `env.ts`, `chunk.ts`, `embed.ts`, `store.ts`, `retrieve.ts`, `ratelimit.ts`, plus the image-pipeline additions:
  - `pdf-extract.ts` — text + page render + embedded images via `unpdf`/`sharp`.
  - `ocr.ts` — Tesseract.js worker wrapper.
  - `vision.ts` — OpenRouter vision-chat helper.
  - `image-cache.ts` — per-session image-dedup cache (sha-256).
  - `pipeline.ts` — orchestrator that produces tagged paragraphs.
- `supabase/` — `schema.sql` (paste into the Supabase SQL editor).

## Guarantee

If the answer is not in the uploaded PDF, the app responds with the literal string `I couldn't find that in this PDF.` — no outside knowledge.

---

The previous build spec is at [`../CHAT_WITH_PDFS_PLAN.md`](../CHAT_WITH_PDFS_PLAN.md).
