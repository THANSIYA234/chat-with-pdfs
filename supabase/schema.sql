-- chat-with-pdfs Supabase schema.
--
-- Apply once in the Supabase SQL editor (or via `supabase db push`).
--
-- IMPORTANT: `chunks.embedding` is `vector(2048)` to match `EMBED_DIMS=2048`
-- (the default for `nvidia/nemotron-3-embed-1b:free`). If you change
-- `EMBED_DIMS`, drop the chunks table before re-applying this file
-- OR follow the manual resizing recipe in the README. Existing data is
-- never silently destroyed by this script.
--
-- Migration-only statements (the ALTER TABLE / CREATE TABLE blocks at the
-- bottom) are idempotent and safe to re-run after upgrading an older
-- deployment — they pull in the image-understanding columns without
-- dropping any existing rows.

create extension if not exists vector;

-- A session owns the embedding representation of one uploaded PDF.
create table if not exists sessions (
  id              uuid        primary key default gen_random_uuid(),
  document_name   text        not null,
  created_at      timestamptz not null default now(),
  last_accessed_at timestamptz not null default now(),
  expires_at      timestamptz not null
);

create index if not exists sessions_expires_at_idx
  on sessions (expires_at);

-- Per-chunk text + its embedding vector. Cascade on delete so
-- dropping a session also drops its chunks.
--
-- `source_type` lets us distinguish content origins at retrieval time:
--   'text'              — extractable PDF text (the legacy path)
--   'ocr'               — text recovered by OCR from a scanned page
--   'image_description' — natural-language description emitted by a vision model
--
-- `image_hash` is the sha-256 of the underlying pixel buffer when the chunk
-- came from an embedded raster image; null for plain text/OCR chunks.
--
-- Width MUST equal `EMBED_DIMS`. The default is 2048 to match
-- `nvidia/nemotron-3-embed-1b:free`. To migrate an existing deployment:
--   1. Stop accepting new uploads.
--   2. `alter table chunks add column embedding_new vector(<new_dims>);`
--   3. Re-embed every row (one-time batch) and copy into embedding_new.
--   4. `alter table chunks drop column embedding;`
--   5. `alter table chunks rename column embedding_new to embedding;`
--   6. Re-apply this file to refresh `match_chunks`.
create table if not exists chunks (
  id          bigserial    primary key,
  session_id  uuid         not null references sessions(id) on delete cascade,
  document    text         not null,
  page        int          not null,
  chunk_index int          not null,
  content     text         not null,
  embedding   vector(2048) not null,
  source_type text         not null default 'text',
  image_hash  text
);

create index if not exists chunks_session_id_idx
  on chunks (session_id);

create index if not exists chunks_source_type_idx
  on chunks (source_type);

-- Cosine-similarity search restricted to one session.
-- `1 - (embedding <=> query_embedding)` turns pgvector's cosine *distance*
-- into a cosine *similarity* in the [0, 1] range (vectors are normalized
-- for the supported embed models).
create or replace function match_chunks(
  query_embedding   vector,
  filter_session_id  uuid,
  match_count       int default 5
)
returns table (
  id          bigint,
  document    text,
  page        int,
  chunk_index int,
  content     text,
  similarity  float,
  source_type text,
  image_hash  text
)
language sql stable
as $$
  select
    c.id,
    c.document,
    c.page,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity,
    c.source_type,
    c.image_hash
  from chunks c
  where c.session_id = filter_session_id
  order by c.embedding <=> query_embedding
  limit match_count
$$;

-- LRU eviction helper: drop the `n` oldest sessions by `last_accessed_at`.
-- Used by the upload route to keep the active session table under the
-- configured cap.
create or replace function evict_oldest_sessions(n int)
returns int
language sql
as $$
  with victims as (
    select id from sessions order by last_accessed_at asc limit n
  )
  delete from sessions where id in (select id from victims);
  select n;
$$;

-- Image de-dup: per-session cache keyed on the sha-256 of the pixel buffer.
-- When the same image is encountered twice inside one session (same image
-- reused on a slide deck, watermarked logo across every page, etc.) we
-- emit exactly one `image_description` chunk and reuse it everywhere.
create table if not exists image_descriptions (
  session_id  uuid         not null references sessions(id) on delete cascade,
  image_hash  text         not null,
  page        int          not null,
  description text         not null,
  created_at  timestamptz  not null default now(),
  primary key (session_id, image_hash)
);

create index if not exists image_descriptions_session_id_idx
  on image_descriptions (session_id);

-- Migration shims — safe to re-run on existing deployments. These add
-- the image-understanding columns to older `chunks` tables without
-- touching existing rows.
alter table chunks
  add column if not exists source_type text not null default 'text';
alter table chunks
  add column if not exists image_hash text;
create index if not exists chunks_source_type_idx on chunks (source_type);

-- Refresh the RPC so older deployments get the new columns in their result
-- set. (The function body above is already id-potent.)
drop function if exists match_chunks(vector, uuid, int);
create or replace function match_chunks(
  query_embedding   vector,
  filter_session_id uuid,
  match_count       int default 5
)
returns table (
  id          bigint,
  document    text,
  page        int,
  chunk_index int,
  content     text,
  similarity  float,
  source_type text,
  image_hash  text
)
language sql stable
as $$
  select
    c.id,
    c.document,
    c.page,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity,
    c.source_type,
    c.image_hash
  from chunks c
  where c.session_id = filter_session_id
  order by c.embedding <=> query_embedding
  limit match_count
$$;