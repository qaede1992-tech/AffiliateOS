export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Rate-limit max must be a positive integer.");
    }
    if (!Number.isInteger(windowMs) || windowMs < 1_000) {
      throw new Error("Rate-limit window must be at least 1000 milliseconds.");
    }
  }

  consume(key: string, now = Date.now()): RateLimitResult {
    const current = this.buckets.get(key);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + this.windowMs }
      : current;

    bucket.count += 1;
    this.buckets.set(key, bucket);

    if (this.buckets.size > 10_000) {
      for (const [bucketKey, value] of this.buckets) {
        if (value.resetAt <= now) this.buckets.delete(bucketKey);
      }
    }

    const allowed = bucket.count <= this.limit;
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));

    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - bucket.count),
      retryAfterSeconds
    };
  }
}

export function configuredRateLimit(): { enabled: boolean; limit: number; windowMs: number } {
  const production = process.env.NODE_ENV === "production";
  const rawLimit = process.env.API_RATE_LIMIT_MAX?.trim();
  const rawWindow = process.env.API_RATE_LIMIT_WINDOW_MS?.trim();

  const limit = rawLimit ? Number(rawLimit) : 120;
  const windowMs = rawWindow ? Number(rawWindow) : 60_000;

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("API_RATE_LIMIT_MAX must be a positive integer.");
  }
  if (!Number.isInteger(windowMs) || windowMs < 1_000) {
    throw new Error("API_RATE_LIMIT_WINDOW_MS must be an integer of at least 1000.");
  }

  return { enabled: production || Boolean(rawLimit), limit, windowMs };
}
