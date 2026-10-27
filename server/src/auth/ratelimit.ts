/**
 * Sign-in throttling, in memory only (client addresses are never written to
 * the database: they would be personal data with no other use).
 *
 * Failures are counted in a sliding window per account and per client
 * address. Past the limit the caller gets a 429 with the seconds until the
 * oldest failure leaves the window. A success clears the account's count but
 * not the address's, so one known account cannot be used to reset guessing
 * against others. The map is bounded so a flood of addresses cannot exhaust
 * memory: the least recently touched keys go first.
 */
export interface RateLimitPolicy {
  windowMs: number;
  perAccount: number;
  perAddress: number;
  maxKeys: number;
}

export const DEFAULT_LOGIN_LIMITS: RateLimitPolicy = { windowMs: 15 * 60 * 1000, perAccount: 5, perAddress: 20, maxKeys: 10_000 };

export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly policy: RateLimitPolicy;
  private readonly now: () => number;

  constructor(policy: Partial<RateLimitPolicy> = {}, now: () => number = Date.now) {
    this.policy = { ...DEFAULT_LOGIN_LIMITS, ...policy };
    this.now = now;
  }

  /** Seconds to wait, or 0 if a sign-in may be tried now. */
  retryAfterS(account: string, address: string): number {
    const now = this.now();
    const wait = Math.max(this.waitFor(`a:${account.toLowerCase()}`, this.policy.perAccount, now), this.waitFor(`ip:${address}`, this.policy.perAddress, now));
    return Math.ceil(wait / 1000);
  }

  fail(account: string, address: string): void {
    const now = this.now();
    for (const key of [`a:${account.toLowerCase()}`, `ip:${address}`]) {
      const list = this.prune(key, now);
      list.push(now);
      this.failures.delete(key);
      this.failures.set(key, list);
    }
    while (this.failures.size > this.policy.maxKeys) this.failures.delete(this.failures.keys().next().value!);
  }

  succeed(account: string): void {
    this.failures.delete(`a:${account.toLowerCase()}`);
  }

  private waitFor(key: string, limit: number, now: number): number {
    const list = this.prune(key, now);
    if (list.length < limit) return 0;
    return list[list.length - limit]! + this.policy.windowMs - now;
  }

  private prune(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((at) => now - at < this.policy.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }
}

/** A plain token bucket, for WebSocket frames and expensive routes. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly capacity: number;
  private readonly perSecond: number;
  private readonly now: () => number;
  constructor(
    capacity: number,
    perSecond: number,
    now: () => number = Date.now,
  ) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }
  take(cost = 1): boolean {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}
