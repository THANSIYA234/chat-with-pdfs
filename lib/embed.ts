/**
 * OpenRouter embeddings client.
 *
 * Wraps POST https://openrouter.ai/api/v1/embeddings with the kit's
 * strict `input_type` distinction:
 *   - `search_query`    — used at request time by `lib/retrieve.ts`
 *   - `search_document` — used at ingest time by `scripts/embed.ts`
 *
 * Both helpers throw on non-2xx with the upstream response body included
 * so ingestion / retrieval failures are diagnosable in one log line.
 */
import { env } from "@/lib/env";

const ENDPOINT = "https://openrouter.ai/api/v1/embeddings";

interface OpenRouterEmbedding {
  embedding: number[];
  index: number;
  object: string;
}

interface OpenRouterEmbeddingsResponse {
  data: OpenRouterEmbedding[];
  model: string;
  object: string;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export type EmbedInputType = "search_query" | "search_document";

interface EmbedArgs {
  input: string | string[];
  input_type: EmbedInputType;
}

/**
 * Low-level request helper. Exposed so future callers (e.g. tests) can
 * share the exact same request body shape used by the kit.
 */
export async function requestEmbeddings(
  args: EmbedArgs,
): Promise<OpenRouterEmbeddingsResponse> {
  const body = {
    model: env.EMBED_MODEL,
    input: args.input,
    dimensions: env.EMBED_DIMS,
    input_type: args.input_type,
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(
      `[embed] OpenRouter ${res.status} ${res.statusText}: ${errBody}`,
    );
  }

  return (await res.json()) as OpenRouterEmbeddingsResponse;
}

/**
 * Embed a single user question for retrieval. Uses `input_type:
 * "search_query"` per OpenRouter's asymmetric embedding spec.
 */
export async function embedQuery(text: string): Promise<number[]> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("[embed] embedQuery: text must be a non-empty string");
  }
  const res = await requestEmbeddings({
    input: trimmed,
    input_type: "search_query",
  });
  const first = res.data?.[0];
  if (!first || !Array.isArray(first.embedding)) {
    throw new Error(
      `[embed] OpenRouter response missing data[0].embedding: ${JSON.stringify(res).slice(0, 200)}`,
    );
  }
  return first.embedding;
}

/**
 * Embed a batch of corpus chunks for ingestion. Uses `input_type:
 * "search_document"` so the vectors are tuned to be matched against
 * `search_query` vectors emitted by `embedQuery`.
 *
 * Returns the full ordered array of embeddings; positional alignment
 * with `texts` is preserved by OpenRouter's response order.
 */
export async function embedDocuments(
  texts: string[],
): Promise<number[][]> {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error("[embed] embedDocuments: texts must be a non-empty array");
  }
  const res = await requestEmbeddings({
    input: texts,
    input_type: "search_document",
  });
  if (!Array.isArray(res.data) || res.data.length !== texts.length) {
    throw new Error(
      `[embed] OpenRouter returned ${res.data?.length ?? 0} embeddings for ${texts.length} inputs`,
    );
  }
  // Sort by `index` to guarantee alignment with `texts` regardless of
  // upstream ordering quirks.
  const sorted = [...res.data].sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}