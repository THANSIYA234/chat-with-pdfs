/**
 * Vision-model wrapper.
 *
 * Two providers, selected via `env.VISION_PROVIDER`:
 *
 *   - "openrouter" — `POST https://openrouter.ai/api/v1/chat/completions`
 *      with `VISION_MODEL` (must accept image input; account needs credits).
 *   - "minimax"    — `POST ${MINIMAX_BASE_URL}/chat/completions` with
 *      `MINIMAX_MODEL` (multimodal). Reuses the same `MINIMAX_API_KEY`
 *      that powers the cited-answer path, so no OpenRouter credits needed.
 *
 * Two helpers:
 *
 *   `describeImage(buf)`        — generic "what is in this picture?"
 *   `describeRenderedPage(buf)` — same payload, prompt tuned for full-page
 *      renders (charts, diagrams, scanned tables).
 *
 * Failure surface:
 *
 *   `VisionError` is thrown on any HTTP / parse / network failure.
 *   Callers can catch it and decide whether to retry, skip, or surface
 *   it to the user. Transient errors (429 / 5xx / network) are retried
 *   with exponential backoff up to `VISION_MAX_ATTEMPTS` times before
 *   giving up.
 *
 *   `describeImage` / `describeRenderedPage` accept an optional injected
 *   `describeFn` so tests can stub the network call without needing a
 *   real vision-capable model or paid credits.
 */
import { env } from "@/lib/env";

/** Retries for transient errors (429, 5xx, network). */
const VISION_MAX_ATTEMPTS = 3;
/** Base backoff in ms; doubled per attempt. */
const VISION_BACKOFF_MS = 1_500;
/** Default per-call timeout. Generous because vision can be slow. */
const VISION_TIMEOUT_MS = 60_000;

const COMMON_RULES = [
  "Reply in plain text only.",
  "Be specific: name visible labels, axis titles, units, numbers, "
    + "legend entries, and any text shown on the image.",
  "If the image is decorative (no informational content), reply with "
    + "exactly: NONE.",
  "Do not start with phrases like 'The image shows' — go straight to "
    + "the description.",
  "Keep the description under 400 words.",
].join(" ");

const PAGE_PROMPT =
  `Describe what a reader would learn from this rendered page of a PDF. ` +
  `Cover every visible chart, diagram, photo, table, and caption. ` +
  `For charts include the axis labels, units, and any numeric values you ` +
  `can read. For tables include column headers and at least the first row. ` +
  `For photos/diagrams describe the scene and any text overlaid on it. ` +
  COMMON_RULES;

const IMAGE_PROMPT =
  `Describe what this picture contributes to the PDF it was extracted from. ` +
  `For diagrams, name the connected boxes/steps and any arrow labels. ` +
  `For screenshots, transcribe the visible UI text. ` +
  `For photos or illustrations, describe the scene and any embedded text. ` +
  COMMON_RULES;

interface ChatChoice {
  message?: { content?: string | null | Array<unknown> };
  finish_reason?: string;
}
interface ChatResponse {
  choices?: ChatChoice[];
  error?: { message?: string; type?: string };
}

export class VisionError extends Error {
  readonly status?: number;
  readonly provider: string;
  readonly model: string;
  readonly cause?: unknown;
  constructor(
    message: string,
    opts: { status?: number; provider: string; model: string; cause?: unknown } = {
      provider: "unknown",
      model: "unknown",
    },
  ) {
    super(message);
    this.name = "VisionError";
    this.status = opts.status;
    this.provider = opts.provider;
    this.model = opts.model;
    this.cause = opts.cause;
  }
}

/** Strip `<think>…</think>` blocks some reasoning models emit. */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Low-level injection point for tests. The default uses the configured
 * provider (`env.VISION_PROVIDER`) and dispatches to the matching
 * transport.
 */
export type DescribeFn = (
  prompt: string,
  png: Buffer | Uint8Array,
  timeoutMs: number,
) => Promise<string>;

// --- OpenRouter transport -------------------------------------------------

async function callOpenRouter(
  prompt: string,
  png: Buffer | Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const buf = png instanceof Buffer ? png : Buffer.from(png);
  const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  const model = env.VISION_MODEL;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= VISION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 600,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });

      if (res.ok) {
        const data = (await res.json()) as ChatResponse;
        const content = data.choices?.[0]?.message?.content;
        const text = extractContentText(content);
        if (text === null) {
          throw new VisionError(
            `[vision/openrouter] missing content: ${data.error?.message ?? "unknown"}`,
            { provider: "openrouter", model },
          );
        }
        const trimmed = stripThinkTags(text).trim();
        if (trimmed.toUpperCase() === "NONE" || trimmed === "NONE.") return "";
        console.log(
          `[vision/openrouter] ok model=${model} bytes=${buf.byteLength} desc_chars=${trimmed.length}`,
        );
        return trimmed;
      }

      const errText = await res.text().catch(() => "");
      if (res.status !== 429 && res.status < 500) {
        throw new VisionError(
          `[vision/openrouter] HTTP ${res.status} ${res.statusText}: ${errText.slice(0, 500)}`,
          { status: res.status, provider: "openrouter", model },
        );
      }
      lastErr = new VisionError(
        `[vision/openrouter] transient HTTP ${res.status}: ${errText.slice(0, 200)}`,
        { status: res.status, provider: "openrouter", model },
      );
    } catch (err) {
      if (err instanceof VisionError && !err.status) throw err;
      lastErr = err;
    }
    if (attempt < VISION_MAX_ATTEMPTS) {
      const delay = VISION_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(
        `[vision/openrouter] retry ${attempt}/${VISION_MAX_ATTEMPTS - 1} after ${delay}ms (model=${model})`,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw new VisionError(
    `[vision/openrouter] call failed after ${VISION_MAX_ATTEMPTS} attempts`,
    { provider: "openrouter", model, cause: lastErr },
  );
}

// --- MiniMax transport ----------------------------------------------------

async function callMiniMax(
  prompt: string,
  png: Buffer | Uint8Array,
  timeoutMs: number,
): Promise<string> {
  const buf = png instanceof Buffer ? png : Buffer.from(png);
  const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
  const model = env.MINIMAX_MODEL;
  const url = `${env.MINIMAX_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= VISION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.MINIMAX_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 600,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as ChatResponse;
        const content = data.choices?.[0]?.message?.content;
        const text = extractContentText(content);
        if (text === null) {
          throw new VisionError(
            `[vision/minimax] missing content: ${data.error?.message ?? "unknown"}`,
            { provider: "minimax", model },
          );
        }
        const trimmed = stripThinkTags(text).trim();
        if (trimmed.toUpperCase() === "NONE" || trimmed === "NONE.") return "";
        console.log(
          `[vision/minimax] ok model=${model} bytes=${buf.byteLength} desc_chars=${trimmed.length}`,
        );
        return trimmed;
      }
      const errText = await res.text().catch(() => "");
      if (res.status !== 429 && res.status < 500) {
        throw new VisionError(
          `[vision/minimax] HTTP ${res.status} ${res.statusText}: ${errText.slice(0, 500)}`,
          { status: res.status, provider: "minimax", model },
        );
      }
      lastErr = new VisionError(
        `[vision/minimax] transient HTTP ${res.status}: ${errText.slice(0, 200)}`,
        { status: res.status, provider: "minimax", model },
      );
    } catch (err) {
      if (err instanceof VisionError && !err.status) throw err;
      lastErr = err;
    }
    if (attempt < VISION_MAX_ATTEMPTS) {
      const delay = VISION_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(
        `[vision/minimax] retry ${attempt}/${VISION_MAX_ATTEMPTS - 1} after ${delay}ms (model=${model})`,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw new VisionError(
    `[vision/minimax] call failed after ${VISION_MAX_ATTEMPTS} attempts`,
    { provider: "minimax", model, cause: lastErr },
  );
}

const defaultDescribe: DescribeFn = (prompt, png, timeoutMs) => {
  if (env.VISION_PROVIDER === "minimax") {
    return callMiniMax(prompt, png, timeoutMs);
  }
  return callOpenRouter(prompt, png, timeoutMs);
};

function extractContentText(
  content: string | unknown[] | null | undefined,
): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        (part as { type?: string }).type === "text" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        parts.push((part as { text: string }).text);
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

async function callVision(
  prompt: string,
  png: Buffer | Uint8Array,
  describeFn: DescribeFn = defaultDescribe,
  timeoutMs = VISION_TIMEOUT_MS,
): Promise<string> {
  return describeFn(prompt, png, timeoutMs);
}

/** Returns "" if the vision model is disabled (kill switch). */
export async function describeImage(
  png: Buffer | Uint8Array,
  describeFn?: DescribeFn,
): Promise<string> {
  if (!env.ENABLE_VISION) return "";
  try {
    return await callVision(IMAGE_PROMPT, png, describeFn);
  } catch (err) {
    if (err instanceof VisionError) throw err;
    const provider = env.VISION_PROVIDER;
    const model = provider === "minimax" ? env.MINIMAX_MODEL : env.VISION_MODEL;
    throw new VisionError(
      `[vision/${provider}] describeImage failed: ${err instanceof Error ? err.message : String(err)}`,
      { provider, model, cause: err },
    );
  }
}

/** Returns "" if the vision model is disabled (kill switch). */
export async function describeRenderedPage(
  png: Buffer | Uint8Array,
  describeFn?: DescribeFn,
): Promise<string> {
  if (!env.ENABLE_VISION) return "";
  try {
    return await callVision(PAGE_PROMPT, png, describeFn);
  } catch (err) {
    if (err instanceof VisionError) throw err;
    const provider = env.VISION_PROVIDER;
    const model = provider === "minimax" ? env.MINIMAX_MODEL : env.VISION_MODEL;
    throw new VisionError(
      `[vision/${provider}] describeRenderedPage failed: ${err instanceof Error ? err.message : String(err)}`,
      { provider, model, cause: err },
    );
  }
}