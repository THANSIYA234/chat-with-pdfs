/**
 * GET /api/health — liveness probe.
 *
 * Always 200 with `{ ok: true, ts: ISO-8601 }`. No external calls so it
 * doubles as a smoke endpoint that doesn't need keys.
 */
import { NextResponse } from "next/server";

// Note: cacheComponents (enabled in next.config.ts) supersedes the
// legacy `export const dynamic = "force-dynamic"` in Next 16. The
// route has no input so it's effectively static-but-never-cached.

export function GET(): Response {
  return NextResponse.json({ ok: true, ts: new Date().toISOString() });
}