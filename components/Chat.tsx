/**
 * Chat panel — client component.
 *
 * Two modes: upload-only when there is no live session, and chat once a
 * PDF has been uploaded. On reload, the previously stored sessionId is
 * read from localStorage and the UI shows a "stale" banner — the user
 * must re-upload because the in-memory chunk store is gone.
 *
 * Tailwind utilities only; dark mode is driven by `prefers-color-scheme`
 * via `app/globals.css`.
 */
"use client";

import { FormEvent, useEffect, useState } from "react";

type Role = "user" | "assistant";

interface ChatCitation {
  document: string;
  page: number;
}

interface ChatMessage {
  role: Role;
  text?: string;
  citations?: ChatCitation[];
}

interface UploadResponse {
  sessionId?: string;
  documentName?: string;
  numChunks?: number;
  numPages?: number;
  error?: string;
  message?: string;
}

interface AskResponse {
  answer?: string;
  citations?: ChatCitation[];
  error?: string;
  message?: string;
}

export default function Chat() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [documentName, setDocumentName] = useState<string>("");
  const [numChunks, setNumChunks] = useState<number>(0);
  const [numPages, setNumPages] = useState<number>(0);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleSession, setStaleSession] = useState(false);

  // On mount, restore the last sessionId so the user knows their PDF is
  // gone from memory. We never auto-call /api/ask because the chunks
  // and embeddings live only in the server's process memory.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("pdfSessionId");
    if (stored) {
      setSessionId(stored);
      setStaleSession(true);
    }
  }, []);

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

    const url = URL.createObjectURL(file);
    setBlobUrl(url);

    const fd = new FormData();
    fd.append("file", file);

    try {
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
        if (typeof window !== "undefined") {
          window.localStorage.setItem("pdfSessionId", data.sessionId);
        }
        setMessages([]);
        setStaleSession(false);
        setError(null);
      } else {
        setError(data.message ?? "Upload failed");
        URL.revokeObjectURL(url);
        setBlobUrl(null);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Upload failed";
      setError(message);
      URL.revokeObjectURL(url);
      setBlobUrl(null);
    } finally {
      setUploading(false);
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
    setMessages([]);
    setInput("");
    setError(null);
    setStaleSession(false);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem("pdfSessionId");
    }
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
            className="flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-zinc-300 bg-white px-6 py-16 text-center text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
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
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Uploading...
            </p>
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
                        {m.citations.map((c, ci) => (
                          <a
                            key={`${c.document}-${c.page}-${ci}`}
                            href={`${blobUrl}#page=${c.page}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 text-xs font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
                          >
                            p.{c.page}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )
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
