/**
 * Chat panel — client component.
 *
 * Two modes: upload-only when there is no live session, and chat once a
 * PDF has been uploaded. On reload, the previously stored sessionId is
 * read from localStorage and the UI shows a "stale" banner — the user
 * must re-upload because the in-memory chunk store is gone.
 *
 * Upload progress is observed through the same `uploading` boolean but
 * extended with a small per-stage label fed by `/api/upload` response so
 * the user can see whether the file is being parsed, OCR'd, or
 * described by the vision model.
 *
 * Citations now carry a `source_type` so the user can tell at a glance
 * whether a page was sourced from PDF text, OCR, or an image
 * description. The chip label uses a short tag: `t` / `o` / `i`.
 *
 * Tailwind utilities only; dark mode is driven by `prefers-color-scheme`
 * via `app/globals.css`.
 */
"use client";

import { FormEvent, useEffect, useState, useSyncExternalStore } from "react";

type Role = "user" | "assistant";
type SourceType = "text" | "ocr" | "image_description";

interface ChatCitation {
  document: string;
  page: number;
  snippet?: string;
  source_type?: SourceType;
}

interface ChatMessage {
  role: Role;
  text?: string;
  citations?: ChatCitation[];
}

interface PipelineStats {
  pages: number;
  textPages: number;
  renderedPages: number;
  embeddedImages: number;
  describedImages: number;
  ocrPages: number;
}

interface UploadResponse {
  sessionId?: string;
  documentName?: string;
  numChunks?: number;
  numPages?: number;
  pipeline?: PipelineStats;
  error?: string;
  message?: string;
}

interface AskResponse {
  answer?: string;
  citations?: ChatCitation[];
  error?: string;
  message?: string;
}

const SOURCE_LABEL: Record<SourceType, string> = {
  text: "t",
  ocr: "o",
  image_description: "i",
};
const SOURCE_TITLE: Record<SourceType, string> = {
  text: "Page text",
  ocr: "OCR text",
  image_description: "Image description",
};

const PDF_SESSION_STORAGE_KEY = "pdfSessionId";

// Pub/sub for the persisted session id. `useSyncExternalStore` only
// re-evaluates its snapshot when the registered listener fires, so we
// fan-out through this Set to:
//  * trigger the post-hydration re-render that reads the actual
//    localStorage value (server snapshot is always `null`),
//  * propagate same-tab writes from the upload success path and
//    `resetSession` to the React tree without each callsite reaching
//    for `window.localStorage` directly,
//  * (optionally) cross-tab `storage` events so opening the chat in
//    another tab picks up the latest upload there too.
const pdfSessionIdListeners = new Set<() => void>();

function getStoredSessionIdSnapshot(): string | null {
  return window.localStorage.getItem(PDF_SESSION_STORAGE_KEY);
}

function getServerStoredSessionIdSnapshot(): string | null {
  return null;
}

function subscribeStoredSessionId(listener: () => void): () => void {
  pdfSessionIdListeners.add(listener);
  // React only re-checks the snapshot when the listener fires, so we
  // schedule an initial check after registration to bring the
  // post-hydration render in line with the actual localStorage value
  // rather than leaving it pinned to the server snapshot.
  queueMicrotask(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === PDF_SESSION_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    pdfSessionIdListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function writeStoredSessionId(value: string | null): void {
  if (value === null) {
    window.localStorage.removeItem(PDF_SESSION_STORAGE_KEY);
  } else {
    window.localStorage.setItem(PDF_SESSION_STORAGE_KEY, value);
  }
  pdfSessionIdListeners.forEach((l) => l());
}

export default function Chat() {
  const [documentName, setDocumentName] = useState<string>("");
  const [numChunks, setNumChunks] = useState<number>(0);
  const [numPages, setNumPages] = useState<number>(0);
  const [pipeline, setPipeline] = useState<PipelineStats | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadStage, setUploadStage] = useState<string>("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The previously stored sessionId lives in localStorage, which is
  // browser-only. Reading it inside a lazy `useState` initializer would
  // diverge between SSR (`typeof window === "undefined"`) and the first
  // client render (where `window` is defined and localStorage may carry
  // a stored id), triggering a hydration mismatch — the server renders
  // the upload `<label>` while the client initially renders the stale
  // warning. `useSyncExternalStore` is the React-canonical way to read
  // from external browser-only stores during SSR/hydration: the server
  // snapshot seeds both the server HTML and the first client render
  // (matching), and the client snapshot is applied in a post-hydration
  // update that flips `staleSession` on without touching the upload UI.
  // We never auto-call /api/ask because the chunks and embeddings live
  // only in the server's process memory — the user must re-upload
  // regardless.
  const storedSessionId = useSyncExternalStore(
    subscribeStoredSessionId,
    getStoredSessionIdSnapshot,
    getServerStoredSessionIdSnapshot,
  );
  // `sessionId` is the active session — set after a successful upload,
  // or cleared by `resetSession`. It starts as `null` so the SSR/first
  // client render stays in sync; the stored value is not auto-trusted
  // because the server has forgotten the in-memory chunks/embeddings.
  const [sessionId, setSessionId] = useState<string | null>(null);
  // The session is stale when there's a persisted id that doesn't
  // match the active one. On a cold page load with a stored id,
  // sessionId is null and storedSessionId is non-null, so the banner
  // shows. After a successful upload (or a reset), the two either
  // agree or both go null/empty and the banner clears.
  const staleSession =
    storedSessionId !== null && sessionId !== storedSessionId;

  // Revoke any blob URL we created when it changes or on unmount, so we
  // never leak object URLs the browser can no longer reach.
  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError(null);
    setUploadStage("Reading file…");

    const url = URL.createObjectURL(file);
    setBlobUrl(url);

    const fd = new FormData();
    fd.append("file", file);

    try {
      // Update the stage label a few times so the UI feels alive on
      // large files. The actual pipeline stages are server-side.
      setUploadStage("Extracting text, images, and OCR…");
      const res = await fetch("/api/upload", {
        method: "POST",
        body: fd,
      });
      const data: UploadResponse = await res.json().catch(() => ({}));
      if (res.status === 201 && data.sessionId) {
        setSessionId(data.sessionId);
        setDocumentName(data.documentName ?? file.name);
        setNumChunks(data.numChunks ?? 0);
        setNumPages(data.numPages ?? 0);
        setPipeline(data.pipeline ?? null);
        writeStoredSessionId(data.sessionId);
        setMessages([]);
        setError(null);
      } else {
        setError(data.message ?? "Upload failed");
        URL.revokeObjectURL(url);
        setBlobUrl(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      setError(message);
      URL.revokeObjectURL(url);
      setBlobUrl(null);
    } finally {
      setUploading(false);
      setUploadStage("");
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sessionId || !input.trim() || asking) return;

    const q = input.trim();
    setMessages((prev) => [...prev, { role: "user", text: q }]);
    setInput("");
    setAsking(true);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, question: q }),
      });
      const data: AskResponse = await res.json().catch(() => ({}));
      if (res.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: data.answer ?? "",
            citations: data.citations ?? [],
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: "[error] " + (data.message ?? "ask failed"),
          },
        ]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "ask failed";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "[error] " + message },
      ]);
    } finally {
      setAsking(false);
    }
  }

  function resetSession() {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null);
    setSessionId(null);
    setDocumentName("");
    setNumChunks(0);
    setNumPages(0);
    setPipeline(null);
    setMessages([]);
    setInput("");
    setError(null);
    writeStoredSessionId(null);
  }

  const showUpload = !sessionId || staleSession;

  return (
    <section className="w-full max-w-3xl">
      {showUpload ? (
        <div className="flex w-full flex-col gap-4">
          {staleSession ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              Your previous PDF is no longer in memory. Re-upload to continue.
            </div>
          ) : null}
          <label
            htmlFor="pdf-upload"
            className="flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-zinc-300 bg-white px-6 py-16 text-center text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
          >
            <span className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Upload a PDF
            </span>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              Click to choose a file (max 50&nbsp;MB)
            </span>
            <input
              id="pdf-upload"
              type="file"
              accept="application/pdf"
              onChange={handleFileChange}
              disabled={uploading}
              className="sr-only"
            />
          </label>
          {uploading ? (
            <div className="text-sm text-zinc-600 dark:text-zinc-400">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-zinc-500 dark:bg-zinc-400" />{" "}
              {uploadStage || "Working…"}
            </div>
          ) : null}
          {error ? (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : null}
        </div>
      ) : (
        <div className="flex w-full flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
            <span className="truncate">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {documentName}
              </span>
              {" · "}
              {numChunks} chunks from {numPages} pages
              {pipeline && pipeline.describedImages > 0
                ? ` · ${pipeline.describedImages} image${pipeline.describedImages === 1 ? "" : "s"} described`
                : ""}
              {pipeline && pipeline.ocrPages > 0
                ? ` · ${pipeline.ocrPages} page${pipeline.ocrPages === 1 ? "" : "s"} OCR'd`
                : ""}
            </span>
            <button
              type="button"
              onClick={resetSession}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Upload a different PDF
            </button>
          </div>

          <div className="flex max-h-[60vh] min-h-[200px] flex-col gap-3 overflow-y-auto rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            {messages.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Ask a question about the PDF you just uploaded.
              </p>
            ) : (
              messages.map((m, i) =>
                m.role === "user" ? (
                  <div
                    key={i}
                    className="self-end max-w-[85%] rounded-lg bg-zinc-900 px-3 py-2 text-sm text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                  >
                    {m.text}
                  </div>
                ) : (
                  <div
                    key={i}
                    className="flex max-w-[85%] flex-col gap-2 self-start"
                  >
                    <div className="rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">
                      {m.text}
                    </div>
                    {m.citations && m.citations.length > 0 && blobUrl ? (
                      <div className="flex flex-wrap gap-1.5">
                        {m.citations.map((c, ci) => {
                          const src = c.source_type ?? "text";
                          return (
                            <a
                              key={`${c.document}-${c.page}-${src}-${ci}`}
                              href={`${blobUrl}#page=${c.page}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={SOURCE_TITLE[src]}
                              className="inline-flex items-center gap-1 rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            >
                              <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                                {SOURCE_LABEL[src]}
                              </span>
                              <span>p.{c.page}</span>
                            </a>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ),
              )
            )}
            {asking ? (
              <div className="self-start text-sm text-zinc-500 dark:text-zinc-400">
                Thinking...
              </div>
            ) : null}
          </div>

          <form
            onSubmit={handleSubmit}
            className="flex w-full items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question..."
              disabled={asking}
              className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
            />
            <button
              type="submit"
              disabled={asking || !input.trim()}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-50 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Send
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
