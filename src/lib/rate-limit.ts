/**
 * Tiny in-memory token bucket. The app runs as a single self-hosted Node
 * process behind cloudflared, so process memory is an adequate store.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 50_000;

export function rateLimit(key: string, options: { capacity: number; refillPerSecond: number }): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_KEYS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    bucket = { tokens: options.capacity, updatedAt: now };
    buckets.set(key, bucket);
  }
  const elapsed = (now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsed * options.refillPerSecond);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Client IP as forwarded by Cloudflare, falling back to generic proxy headers. */
export function clientIp(headers: Headers): string {
  return headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? headers.get("x-real-ip") ?? "unknown";
}
