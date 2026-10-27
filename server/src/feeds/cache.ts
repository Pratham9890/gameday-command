import type { Db } from '../db.ts';
import { OutboundBlocked, safeFetch, type SafeFetchDeps } from '../net/safe-fetch.ts';

/**
 * An HTTP cache for feeds, kept in SQLite so a restart (or a lost uplink)
 * still has the last good answer. It honours Cache-Control max-age and
 * Expires, revalidates with ETag / Last-Modified, and backs off on errors:
 * 5 s first (what the NWS asks of clients that hit its rate limit), doubling
 * to at most 15 minutes, or longer if the server sends Retry-After.
 */
interface Row {
  url: string;
  status: number | null;
  etag: string | null;
  last_modified: string | null;
  expires_at: number | null;
  fetched_at: number | null;
  body: string | null;
  failures: number;
  next_attempt_at: number;
  last_error: string | null;
}

export interface CachedBody {
  url: string;
  body: string | null;
  /** When the body was last confirmed by the origin (200 or 304). */
  fetchedAt: number | null;
  fromCache: boolean;
  error: string | null;
}

export interface FeedCacheOptions {
  userAgent: string;
  now: () => number;
  jitter?: () => number;
  maxBytes?: number;
  timeoutMs?: number;
}

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 15 * 60_000;

export function freshnessMs(headers: Record<string, string>, now: number): number | null {
  const cc = headers['cache-control'] ?? '';
  if (/no-store|no-cache/i.test(cc)) return 0;
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cc);
  if (maxAge) return Number(maxAge[1]) * 1000;
  if (headers.expires) {
    const expires = Date.parse(headers.expires);
    const date = headers.date ? Date.parse(headers.date) : now;
    if (Number.isFinite(expires)) return Math.max(0, expires - (Number.isFinite(date) ? date : now));
  }
  return null;
}

export function retryAfterMs(headers: Record<string, string>, now: number): number | null {
  const value = headers['retry-after'];
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export class FeedCache {
  private readonly jitter: () => number;

  private readonly db: Db;
  private readonly deps: SafeFetchDeps;
  private readonly opts: FeedCacheOptions;
  constructor(
    db: Db,
    deps: SafeFetchDeps,
    opts: FeedCacheOptions,
  ) {
    this.db = db;
    this.deps = deps;
    this.opts = opts;
    this.jitter = opts.jitter ?? (() => 0.8 + Math.random() * 0.4);
  }

  private row(url: string): Row | undefined {
    return this.db.prepare('select * from feed_cache where url = ?').get(url) as Row | undefined;
  }

  peek(url: string): CachedBody {
    const row = this.row(url);
    return { url, body: row?.body ?? null, fetchedAt: row?.fetched_at ?? null, fromCache: true, error: row?.last_error ?? null };
  }

  async get(url: string, opts: { minIntervalMs: number; accept?: string; force?: boolean }): Promise<CachedBody> {
    const now = this.opts.now();
    const row = this.row(url);
    if (row?.body && row.expires_at !== null && now < row.expires_at && !opts.force) return { url, body: row.body, fetchedAt: row.fetched_at, fromCache: true, error: null };
    if (row && now < row.next_attempt_at) return { url, body: row.body, fetchedAt: row.fetched_at, fromCache: true, error: row.last_error ?? 'waiting before retrying' };

    const headers: Record<string, string> = { 'user-agent': this.opts.userAgent, accept: opts.accept ?? 'application/geo+json' };
    if (row?.body && row.etag) headers['if-none-match'] = row.etag;
    if (row?.body && row.last_modified) headers['if-modified-since'] = row.last_modified;

    try {
      const res = await safeFetch(url, this.deps, { headers, maxBytes: this.opts.maxBytes ?? 2 * 1024 * 1024, timeoutMs: this.opts.timeoutMs ?? 10_000 });
      const fresh = freshnessMs(res.headers, now);
      const expiresAt = now + Math.max(opts.minIntervalMs, fresh ?? opts.minIntervalMs);
      if (res.status === 304 && row?.body) {
        this.db.prepare('update feed_cache set expires_at = ?, fetched_at = ?, failures = 0, next_attempt_at = 0, last_error = null where url = ?').run(expiresAt, now, url);
        return { url, body: row.body, fetchedAt: now, fromCache: true, error: null };
      }
      if (res.status >= 200 && res.status < 300) {
        const body = res.text();
        this.db
          .prepare('insert or replace into feed_cache (url, status, etag, last_modified, expires_at, fetched_at, body, failures, next_attempt_at, last_error) values (?, ?, ?, ?, ?, ?, ?, 0, 0, null)')
          .run(url, res.status, res.headers.etag ?? null, res.headers['last-modified'] ?? null, expiresAt, now, body);
        return { url, body, fetchedAt: now, fromCache: false, error: null };
      }
      return this.failed(url, row, now, `HTTP ${res.status}${problemDetail(res.text())}`, retryAfterMs(res.headers, now), res.status >= 400 && res.status < 500 && res.status !== 429);
    } catch (error) {
      const message = error instanceof OutboundBlocked ? `${error.reason}: ${error.message}` : error instanceof Error ? error.message : String(error);
      return this.failed(url, row, now, message, null, error instanceof OutboundBlocked && ['not_allowlisted', 'private_address', 'scheme', 'port', 'https_required'].includes(error.reason));
    }
  }

  private failed(url: string, row: Row | undefined, now: number, message: string, retryAfter: number | null, permanent: boolean): CachedBody {
    const failures = (row?.failures ?? 0) + 1;
    const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)) * this.jitter();
    const wait = Math.max(retryAfter ?? 0, permanent ? BACKOFF_MAX_MS : backoff);
    this.db
      .prepare(
        `insert into feed_cache (url, failures, next_attempt_at, last_error) values (?, ?, ?, ?)
         on conflict(url) do update set failures = excluded.failures, next_attempt_at = excluded.next_attempt_at, last_error = excluded.last_error`,
      )
      .run(url, failures, now + Math.round(wait), message.slice(0, 300));
    return { url, body: row?.body ?? null, fetchedAt: row?.fetched_at ?? null, fromCache: true, error: message };
  }
}

function problemDetail(text: string): string {
  try {
    const body = JSON.parse(text) as { title?: string; detail?: string };
    return body.title || body.detail ? ` (${body.title ?? ''}${body.detail && body.detail !== body.title ? `: ${body.detail}` : ''})` : '';
  } catch {
    return '';
  }
}
