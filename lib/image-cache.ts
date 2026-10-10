/**
 * In-memory image dedup helper.
 *
 * For every image we extract (page render or embedded raster), we
 * compute a short sha-256 prefix of the pixel buffer. Two pages with
 * the same chart return the same hash, so we only emit one
 * `image_description` chunk per unique image within a session. The
 * session is used as a cache scope; on a fresh upload we get a fresh
 * UUID and the cache starts empty.
 *
 * Pure (no I/O aside from `crypto`); safe to call from the upload hot
 * path. Concurrent uploads from the same user never share a session
 * because `createSession` rolls a fresh UUID each call.
 */
import { createHash } from "node:crypto";

/** Cheap "fingerprint" — first 16 bytes of sha-256 as 32 hex chars. */
export function sha256Prefix(bytes: Buffer | Uint8Array, n = 16): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex").slice(0, n * 2);
}

export class SessionImageCache {
  private readonly seen = new Map<string, string | null>();

  /**
   * `hash`      — sha-256 prefix of the pixel buffer.
   * `describing` — the description produced for this image, or null if
   *   the image was unimportant and we chose not to describe it
   *   (e.g. tiny logos / purely decorative bars).
   *
   * Returns `true` if this is the first time we've seen the hash in
   * this session; `false` if we've already processed it.
   */
  record(hash: string, description: string | null): boolean {
    if (this.seen.has(hash)) return false;
    this.seen.set(hash, description);
    return true;
  }

  /** `undefined` means we've never seen the hash; the caller must process it. */
  previousDescription(hash: string): string | null | undefined {
    return this.seen.get(hash);
  }

  size(): number {
    return this.seen.size;
  }
}
