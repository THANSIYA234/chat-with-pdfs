# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Knowledge workers — researchers, analysts, consultants, and lawyers — reading long, often scan-heavy reference PDFs they did not author. They land here from a link or search result with a specific question about a document already in their hands; they want a short, page-cited answer drawn from that document, not a chat about it.

## Product Purpose

Turn a single PDF into a queryable, citation-backed reference the user can interrogate in their browser. Success means: drop the PDF, ask in plain language, get a short grounded answer with one clickable chip per cited page — and a contract-grade "I couldn't find that in this PDF." when the document does not say.

## Positioning

Multi-source honesty. Every citation visibly distinguishes whether it was grounded in **native text**, **OCR over a scanned page**, or a **vision-model description of a page or embedded image** (`t` / `o` / `i` chip tags). Neighboring tools that ingest PDFs give a single undifferentiated citation; users here can audit the provenance of each cited claim against their document.

## Operating Context

- Visitor lands on a single upload page (`/`); no signup, no account, no pre-pipeline.
- Drops one PDF (≤ 50 MB); a per-session record is created server-side that holds the parsed pages, chunks, and embeddings in memory only (via Supabase + pgvector for the session's life).
- Chats via the in-page input; answer text plus one chip per citation; chip opens the visitor's own blob PDF at the cited page (browser native viewer).
- Closing the tab forgets the document; sessions expire after 1 hour idle; 100-session LRU cap evicts cold sessions under traffic.
- Rate limit: 20 questions per IP per hour; upload cap 50 MB.
- Hosting: Vercel (Next.js 16 App Router, React 19).

## Capabilities and Constraints

Capabilities (confirmed by the running product):

- **Ingest** — Single-PDF upload (multipart `POST /api/upload`, ≤ 50 MB); native text via `unpdf`; scanned pages rendered to PNG; embedded images extracted via `sharp`.
- **Index** — Per page: text chunk; OCR chunk via Tesseract.js when native text is thin or absent; full-page and per-image vision descriptions via a multimodal model. Image dedup across the session by sha-256.
- **Retrieve** — Top-5 chunks per question via cosine similarity (pgvector `match_chunks` RPC), filtered to the session. A visual-question booster adds +0.25 to `image_description` chunks when the question references visible content.
- **Answer** — MiniMax-M3 (OpenAI-compatible) receives the top chunks as numbered sources `[1]…[5]` plus the question; returns plain text with inline `[n]` claims and the literal refusal string for out-of-scope questions.
- **Visualize citations** — One chip per cited page, labeled with the source type (`t` / `o` / `i`); chip URL is `blob:#<n>` so it jumps the browser PDF viewer to the cited page.
- **Limit traffic** — In-memory per-IP rate limit (20 questions / hour).

Constraints (durable):

- **Ephemeral sessions** — PDF and its chunks live for the tab's life; no server-side document storage, no training on uploads.
- **Single PDF per session** — Upload a new one to replace the current one in that session.
- **Rate caps** — 50 MB upload, 1-hour idle TTL, 100-session LRU cap, 20 questions / hour / IP.
- **Back-end stack** — Supabase Postgres + pgvector is the current store; the retrieval API surface is the contract, not the database.

Explicitly undecided (not in this record until the user resolves them):

- Multi-PDF in one session (current: one-PDF-at-a-time).
- Persistence across reloads (current: reload requires re-upload by design).
- Vertical specialization (law, pharma, finance) — no confirmed audience segment.

## Brand Commitments

These are product facts, not copy under redesign. Future work must not change them without explicit sign-off.

- **Literal refusal string** — `I couldn't find that in this PDF.` is the contract; casing, period, and exact wording are part of the product.
- **Ephemeral sessions** — A privacy contract: the PDF and its chunks never persist server-side. IndexedDB or storage additions are out of scope unless explicitly requested.
- **Multi-source chips** — Every citation carries a visible `t` / `o` / `i` label so the visitor can audit whether the cited claim came from native text, OCR, or a vision-model description.
- **Drop-PDF / no-account UX** — No signup, no corpus prep, no operator steps between landing and chatting; the first-paint commitment.

## Evidence on Hand

- Live product source at `/home/thansiya/chat-with-pdfs/my-app/` (Next.js 16 App Router, full UI in `components/Chat.tsx`, back-end routes under `app/api/`).
- Historical build specs: `../CHAT_WITH_PDFS_PLAN.md`, `../CHAT_WITH_PDFS_RAG_PIVOT_PLAN.md`.
- Test corpus: `my-app/scripts/fixtures/` (`text-only.pdf`, `scanned.pdf`, `embedded.pdf`, `chart.pdf`, `box.pdf`) used by the regression harness.

Absent by design; future work must not fabricate:

- Real-user testimonials, deployment metrics, customer names.
- Pricing, licensing, or commercial claims.

## Product Principles

1. **Show the source.** Every claim carries a chip back to a specific page; every chip carries a label back to a specific source type. The visitor can disagree with the model and verify on the PDF.
2. **Refuse, don't hedge.** When the document doesn't say, say so in the exact string and stop. Refusal is a feature, not a failure.
3. **Forget by default.** The PDF exists for the lifetime of the question, no longer. Privacy is a first-class deliverable, not a checkbox.
4. **One PDF, one session, one click.** No account, no corpus, no operator. The shortest path from "I have a PDF" to "I have an answer" wins.
5. **Multi-source honesty is the niche.** Native text, OCR over scans, and vision over embedded images are three different reliability regimes; the product surfaces that gap rather than hiding it.

## Accessibility & Inclusion

No product-specific requirement beyond general web accessibility (semantic HTML, focus order, keyboard-sendable chat input, `prefers-color-scheme` dark mode already in `globals.css`) has been established. Omit from future briefs unless the user adds one.
