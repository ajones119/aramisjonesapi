export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

export interface FixedWindowRateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

/** A small single-process fixed-window limiter for public, unauthenticated routes. */
export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();
  private readonly now: () => number;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(options: FixedWindowRateLimiterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  consume(key: string): RateLimitDecision {
    const now = this.now();
    this.removeExpired(now);

    const current = this.entries.get(key);
    const entry = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + this.windowMs };

    if (!current || current.resetAt <= now) this.entries.set(key, entry);

    if (entry.count >= this.limit) {
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        resetAt: entry.resetAt,
      };
    }

    entry.count += 1;
    return {
      allowed: true,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      resetAt: entry.resetAt,
    };
  }

  get size(): number {
    this.removeExpired(this.now());
    return this.entries.size;
  }

  private removeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}
