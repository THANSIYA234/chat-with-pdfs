/**
 * Paragraph-aware PDF chunker.
 *
 * Greedily accumulates paragraphs into a chunk until `words >= 400`, then
 * flushes the chunk and carries the last 1-2 sentences of the flushed chunk
 * as overlap into the next one. If a single paragraph exceeds 400 words, it
 * is hard-split on word boundaries at ~400-word slices (sub-chunks follow
 * the same overlap pattern).
 *
 * Image-derived content is fed in as pre-shaped "paragraphs" — the
 * pipeline produces one paragraph per OCR result or vision description,
 * each tagged with a `source_type` and optional `image_hash`. The
 * chunker is otherwise unchanged.
 *
 * Pure / no I/O — `/api/ask` can reuse this for future contextual-retrieval
 * upgrades.
 */

export type SourceType = "text" | "ocr" | "image_description";

export interface ChunkPageInput {
  /** 1-indexed page number from the source PDF. */
  page: number;
  /** Full text extracted from the page (post-trim, non-empty). */
  text: string;
  /** Why this paragraph exists: native text, OCR, or vision description. */
  source_type?: SourceType;
  /** sha-256 prefix of the source image; only set for `image_description`. */
  image_hash?: string;
}

export interface Chunk {
  document: string;
  page: number;
  chunk_index: number;
  content: string;
  source_type: SourceType;
  image_hash: string | null;
}

const TARGET_WORDS = 400;

function wordCount(s: string): number {
  const t = s.trim();
  if (t === "") return 0;
  return t.split(/\s+/).length;
}

/**
 * Split the content into sentence-like fragments (split on `.`, trim, drop
 * empties) and return the last 1-2 of them joined back together, terminated
 * with `. `. Empty input → empty string.
 */
function tailOverlap(content: string): string {
  const sentences = content.split(/\./).map((s) => s.trim()).filter(Boolean);
  if (sentences.length === 0) return "";
  const tail = sentences.slice(-2);
  return tail.join(". ") + ". ";
}

/**
 * Greedy paragraph chunker with overlap.
 *
 * @param document basename of the source document (used as the chunk's
 *   `document` field and as the scope for the running `chunk_index`).
 * @param pages pages in 1-indexed order; their `text` is treated as a single
 *   stream of paragraphs (chunks may cross page boundaries — the `page`
 *   recorded on each chunk is the page where it began).
 */
export function chunkPages(document: string, pages: ChunkPageInput[]): Chunk[] {
  const chunks: Chunk[] = [];
  let chunkIndex = 0;
  let carryOverlap = "";
  let buffer = "";
  let bufferStartPage = -1;
  let bufferSource: SourceType = "text";
  let bufferImageHash: string | null = null;

  const flush = (): void => {
    const content = buffer.trim();
    if (content === "") {
      buffer = "";
      bufferStartPage = -1;
      carryOverlap = "";
      bufferSource = "text";
      bufferImageHash = null;
      return;
    }
    const startPage = bufferStartPage;
    const sourceType = bufferSource;
    const imageHash = bufferImageHash;
    carryOverlap = tailOverlap(content);
    buffer = "";
    bufferStartPage = -1;
    bufferSource = "text";
    bufferImageHash = null;
    chunks.push({
      document,
      page: startPage,
      chunk_index: chunkIndex++,
      content,
      source_type: sourceType,
      image_hash: imageHash,
    });
  };

  const ingest = (
    paragraph: string,
    page: number,
    sourceType: SourceType,
    imageHash: string | null,
  ): void => {
    const trimmed = paragraph.trim();
    if (trimmed === "") return;
    const words = trimmed.split(/\s+/);

    if (words.length > TARGET_WORDS) {
      // Flush any in-flight buffer so the giant paragraph starts a fresh chunk
      // with the previous chunk's overlap as carry.
      if (wordCount(buffer) > 0) flush();

      let cursor = 0;
      while (cursor < words.length) {
        const piece = words.slice(cursor, cursor + TARGET_WORDS).join(" ");
        cursor += TARGET_WORDS;

        const fresh = wordCount(buffer) === 0;
        if (fresh) {
          bufferStartPage = page;
          bufferSource = sourceType;
          bufferImageHash = imageHash;
          buffer = carryOverlap + piece;
        } else {
          buffer = buffer + " " + piece;
        }
        if (wordCount(buffer) >= TARGET_WORDS) flush();
      }
      return;
    }

    // Normal paragraph: append to current buffer (with overlap carry as
    // prefix only when starting fresh) and flush if we crossed the threshold.
    if (wordCount(buffer) === 0) {
      bufferStartPage = page;
      bufferSource = sourceType;
      bufferImageHash = imageHash;
      buffer = carryOverlap + trimmed;
    } else {
      // Different source_type? Flush so the new chunk keeps its true
      // tag — otherwise OCR noise would silently swallow a vision
      // description, and a text chunk would hide an image_description.
      if (bufferSource !== sourceType || bufferImageHash !== imageHash) {
        flush();
      }
      if (wordCount(buffer) === 0) {
        bufferStartPage = page;
        bufferSource = sourceType;
        bufferImageHash = imageHash;
        buffer = carryOverlap + trimmed;
      } else {
        buffer = buffer + "\n\n" + trimmed;
      }
    }
    if (wordCount(buffer) >= TARGET_WORDS) flush();
  };

  for (const { page, text, source_type, image_hash } of pages) {
    const paragraphs = text.split(/\n\s*\n/);
    const sourceType: SourceType = source_type ?? "text";
    const imageHash: string | null = image_hash ?? null;
    for (const p of paragraphs) ingest(p, page, sourceType, imageHash);
  }

  // Final trailing buffer (if any) becomes the last chunk of the document.
  flush();

  return chunks;
}
