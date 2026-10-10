/**
 * Home page — server component.
 *
 * Renders the page header and mounts the client-side Chat component.
 * No filesystem reads: uploads and conversations are session-only.
 */
import Chat from "@/components/Chat";

export default function Home() {
  return (
    <main className="flex w-full flex-1 flex-col items-center gap-6 px-4 py-10 sm:px-8 sm:py-16">
      <header className="w-full max-w-3xl">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Chat with your PDF</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Upload a PDF and ask questions about it — including scanned pages, charts, diagrams, and images. Answers cite the source page and tag the source kind.</p>
      </header>
      <Chat />
    </main>
  );
}
