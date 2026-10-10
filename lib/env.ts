/**
 * Typed environment loader.
 *
 * - Reads `.env.local` once at module load (no-op if file is absent).
 * - Validates every required key on first access; throws a labeled
 *   error listing ALL missing keys so `.env.local` typos are
 *   diagnosable in one shot. The validation is deferred to property
 *   access so `import { env }` is side-effect free — `next build` can
 *   evaluate route modules without `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY`
 *   being set in the build environment.
 * - After first access, the resolved object is memoized; subsequent
 *   property reads return from the frozen cache.
 *
 * Usage: `import { env } from "@/lib/env";`
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED = [
  "OPENROUTER_API_KEY",
  "MINIMAX_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const OPTIONAL = [
  "EMBED_MODEL",
  "EMBED_DIMS",
  "MINIMAX_BASE_URL",
  "MINIMAX_MODEL",
] as const;

export type RequiredKey = (typeof REQUIRED)[number];
export type OptionalKey = (typeof OPTIONAL)[number];

export interface Env {
  OPENROUTER_API_KEY: string;
  MINIMAX_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  EMBED_MODEL: string;
  EMBED_DIMS: number;
  MINIMAX_BASE_URL: string;
  MINIMAX_MODEL: string;
}

let dotenvLoaded = false;
function loadDotenvLocal(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

let cached: Env | null = null;
function buildEnv(): Env {
  loadDotenvLocal();
  const missing: string[] = [];
  for (const k of REQUIRED) {
    if (!process.env[k] || process.env[k]!.trim() === "") missing.push(k);
  }
  if (missing.length) {
    const list = missing.map((k) => `  - ${k}`).join("\n");
    throw new Error(
      `[env] missing required environment variable(s) in .env.local:\n${list}\n` +
        `Copy .env.example to .env.local and fill them in.`,
    );
  }
  return Object.freeze({
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY!,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY!,
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    EMBED_MODEL: process.env.EMBED_MODEL ?? "openai/text-embedding-3-small",
    EMBED_DIMS: Number(process.env.EMBED_DIMS ?? 1536),
    MINIMAX_BASE_URL: process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1",
    MINIMAX_MODEL: process.env.MINIMAX_MODEL ?? "MiniMax-M3",
  });
}

/**
 * Lazy `Env` proxy. Resolves the validated, frozen object on first
 * property access and memoizes it. Plain property access does not
 * trigger `buildEnv()`; only reading a key (e.g. `env.OPENROUTER_API_KEY`)
 * does. This lets `next build` import the module without env vars set.
 */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    if (!cached) cached = buildEnv();
    return (cached as unknown as Record<string, unknown>)[prop];
  },
});