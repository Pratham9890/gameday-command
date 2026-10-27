import type { Hono } from 'hono';
import type { Platform } from '../platform/platform.ts';
import { auditActor } from '../platform/platform.ts';
import { type AppEnv, type Ctx, fail, readBody } from '../platform/http.ts';
import { iso } from '../platform/canonical.ts';
import { v } from '../platform/validate.ts';
import { deny } from '../platform/middleware.ts';
import { OutboundBlocked, safeFetch } from '../net/safe-fetch.ts';

/** The weather feed and the guarded conditions fetch that replaces the open v2 one. */
export const CONDITIONS_TIMEOUT_MS = 8000;
export const CONDITIONS_MAX_BYTES = 512 * 1024;

export type ConditionsResult =
  | { ok: true; text: string; fetchedAt: string; url: string; contentType: string | null }
  | { ok: false; status: 400 | 403 | 413 | 502 | 504; error: string; message: string; reason?: string };

/** Fetch a conditions feed (gate scans, traffic counts) through the allowlist. */
export async function fetchConditions(platform: Platform, c: Ctx, url: string): Promise<ConditionsResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 400, error: 'not a URL', message: 'not a URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, status: 400, error: 'only http and https feeds', message: 'only http and https feeds' };
  try {
    const res = await safeFetch(parsed.href, { allowlist: platform.allowlist, resolver: platform.resolver, transport: platform.transport, now: platform.now }, { maxBytes: CONDITIONS_MAX_BYTES, timeoutMs: CONDITIONS_TIMEOUT_MS, headers: { accept: 'application/json, text/csv, text/plain', 'user-agent': platform.config.feeds.userAgent } });
    if (res.status < 200 || res.status >= 300) return { ok: false, status: 502, error: `feed returned ${res.status}`, message: `feed returned ${res.status}` };
    return { ok: true, text: res.text(), fetchedAt: iso(platform.now()), url: res.url, contentType: res.headers['content-type'] ?? null };
  } catch (error) {
    if (error instanceof OutboundBlocked) {
      const policy = ['not_allowlisted', 'private_address', 'credentials', 'port', 'https_required', 'scheme', 'redirect_limit'].includes(error.reason);
      if (policy) {
        platform.audit.append({ actor: auditActor(c.get('actor')), action: 'outbound.blocked', target: safeHost(error.url), outcome: 'denied', detail: { reason: error.reason } });
        return { ok: false, status: 403, error: 'outbound_blocked', message: error.message, reason: error.reason };
      }
      if (error.reason === 'too_large') return { ok: false, status: 413, error: 'feed is larger than 512 KB', message: error.message, reason: error.reason };
      if (error.reason === 'timeout') return { ok: false, status: 504, error: 'feed timed out', message: error.message, reason: error.reason };
      return { ok: false, status: 502, error: `feed fetch failed: ${error.message}`, message: error.message, reason: error.reason };
    }
    return { ok: false, status: 502, error: `feed fetch failed: ${error instanceof Error ? error.message : String(error)}`, message: 'feed fetch failed' };
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

export function addFeedRoutes(app: Hono<AppEnv>, platform: Platform): void {
  app.get('/api/v3/feeds/weather', (c) => {
    const refused = deny(c, platform, 'feed.read');
    if (refused) return refused;
    const report = platform.weather.report();
    // Serve what we have now; refresh behind it if it is old. The cache keeps this cheap and polite.
    if (platform.weather.enabled && report.status !== 'ok') void platform.weather.refresh().catch(() => {});
    return c.json(report);
  });

  app.post('/api/v3/feeds/weather/refresh', async (c) => {
    const refused = deny(c, platform, 'feed.configure');
    if (refused) return refused;
    if (!platform.weather.enabled) return fail(c, 409, 'not_configured', 'Set GAMEDAY_FEED_CONTACT (an email or URL the NWS can reach you at) to turn the weather feed on.');
    const report = await platform.weather.refresh({ force: true });
    platform.audit.append({ actor: auditActor(c.get('actor')), action: 'feed.refresh', target: 'nws', detail: { status: report.status, errors: report.errors.length } });
    return c.json(report);
  });

  app.post('/api/v3/feeds/fetch', async (c) => {
    const refused = deny(c, platform, 'feed.read');
    if (refused) return refused;
    const body = await readBody(c, v.object({ url: v.string({ min: 1, max: 2000 }) }));
    if (!body.ok) return body.response;
    const result = await fetchConditions(platform, c, body.value.url);
    if (!result.ok) return fail(c, result.status, result.error === 'outbound_blocked' ? 'outbound_blocked' : 'feed_failed', result.message, result.reason ? { reason: result.reason } : {});
    return c.json({ text: result.text, fetchedAt: result.fetchedAt, url: result.url, contentType: result.contentType, provenance: { kind: 'observed', source: new URL(result.url).host, asOf: null, fetchedAt: result.fetchedAt } });
  });
}
