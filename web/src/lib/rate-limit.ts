// Token-bucket rate limit for public API routes. Per-instance in-memory
// store — good enough for DoS protection at small scale; for production
// abuse-prevention you'd back this with Upstash/Redis or Vercel KV.
//
// We don't enforce per-user quotas (no users); the bucket is keyed by
// (route, IP). Vercel surfaces the client IP in the `x-forwarded-for`
// header.

interface Bucket {
  tokens: number;
  refillAt: number;
}

const BUCKETS = new Map<string, Bucket>();
// Eviction: bounded LRU so a single bad actor can't OOM us.
const MAX_KEYS = 5_000;

export interface RateLimitOpts {
  /** Tokens per window. */
  capacity: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetMs: number;
}

export function rateLimit(
  key: string,
  opts: RateLimitOpts,
): RateLimitResult {
  const now = Date.now();
  let bucket = BUCKETS.get(key);
  if (!bucket || bucket.refillAt <= now) {
    bucket = { tokens: opts.capacity, refillAt: now + opts.windowMs };
    BUCKETS.set(key, bucket);
  }
  if (BUCKETS.size > MAX_KEYS) {
    // Cheap eviction: drop the oldest insertion. Map preserves insertion
    // order so this is O(1).
    const oldest = BUCKETS.keys().next().value;
    if (oldest && oldest !== key) BUCKETS.delete(oldest);
  }
  if (bucket.tokens <= 0) {
    return {
      ok: false,
      remaining: 0,
      resetMs: bucket.refillAt - now,
    };
  }
  bucket.tokens -= 1;
  return {
    ok: true,
    remaining: bucket.tokens,
    resetMs: bucket.refillAt - now,
  };
}

/** Extract a client identity from request headers. Falls back to "anon"
 *  if no proxy headers are set (e.g. direct connections in dev). */
export function clientId(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const xr = req.headers.get("x-real-ip");
  if (xr) return xr.trim();
  return "anon";
}

/**
 * Convenience wrapper. Returns a Response with 429 if over the limit, or
 * null to indicate the request should proceed. Adds RateLimit-* headers
 * even on the OK path so callers can self-throttle.
 */
export function enforceRateLimit(
  req: Request,
  route: string,
  opts: RateLimitOpts,
): { headers: Record<string, string>; deny: Response | null } {
  const key = `${route}:${clientId(req)}`;
  const r = rateLimit(key, opts);
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(opts.capacity),
    "RateLimit-Remaining": String(r.remaining),
    "RateLimit-Reset": String(Math.ceil(r.resetMs / 1000)),
  };
  if (!r.ok) {
    return {
      headers,
      deny: new Response(
        JSON.stringify({
          error: "rate_limited",
          retryAfterSeconds: Math.ceil(r.resetMs / 1000),
        }),
        {
          status: 429,
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "Retry-After": String(Math.ceil(r.resetMs / 1000)),
          },
        },
      ),
    };
  }
  return { headers, deny: null };
}
