/**
 * In-memory per-IP rate limiter.
 *
 * Sliding-window bucket keyed on the caller's IP. No external store — fine
 * for the single-instance Vercel deployment described in the plan; if the
 * app ever spans multiple instances, swap the `buckets` Map for Redis or
 * Upstash with the same `check()` signature and nothing else changes.
 *
 * Window: 1 hour, 20 questions per IP. Anything over the limit is rejected
 * by the caller (route handler returns 429 with a friendly message).
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Check whether `ip` is allowed one more question right now and, if so,
 * consume a slot. Pure function over the module-level `buckets` map — no
 * I/O, safe to call from a hot path.
 *
 * @param ip       Caller identifier (use `x-forwarded-for` first IP, or `"anon"`).
 * @param limit    Max questions allowed inside the window. Default 20.
 * @param windowMs Window length in ms. Default 3 600 000 (1 hour).
 */
export function check(
  ip: string,
  limit: number = 20,
  windowMs: number = 3_600_000,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(ip, bucket);
  }
  if (now >= bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
  }
  bucket.count += 1;
  return {
    allowed: true,
    remaining: limit - bucket.count,
    resetAt: bucket.resetAt,
  };
}