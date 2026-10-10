-- chat-with-pdfs Supabase schema.
--
-- Apply once in the Supabase SQL editor (or via `supabase db push`).
-- Re-run the CREATE TABLE for `chunks` if `EMBED_DIMS` ever changes — the
-- pgvector column width is fixed at table creation time.

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
create table if not exists chunks (
  id          bigserial    primary key,
  session_id  uuid         not null references sessions(id) on delete cascade,
  document    text         not null,
  page        int          not null,
  chunk_index int          not null,
  content     text         not null,
  embedding   vector(1536) not null
);

create index if not exists chunks_session_id_idx
  on chunks (session_id);

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
  similarity  float
)
language sql stable
as $$
  select
    c.id,
    c.document,
    c.page,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
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