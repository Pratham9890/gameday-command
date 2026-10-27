import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Actor, AuthMode } from '../types.ts';
import type { SessionRow } from '../auth/sessions.ts';
import { type Check, parse } from './validate.ts';

export type Via = 'cookie' | 'demo' | 'local' | 'none';

export type AppEnv = {
  Variables: {
    actor: Actor | null;
    session: SessionRow | null;
    via: Via;
    address: string;
    mode: AuthMode;
    sessionProblem: string | null;
  };
};

export type Ctx = Context<AppEnv>;

export function fail(c: Context, status: ContentfulStatusCode, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return c.json({ error, message, ...extra }, status);
}

/** Parse and check a JSON body. JSON routes require `application/json`, which a cross-site form cannot send without a preflight this server never answers. */
export async function readBody<T>(c: Context, check: Check<T>): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  const type = (c.req.header('content-type') ?? '').toLowerCase();
  if (!type.startsWith('application/json')) {
    return { ok: false, response: fail(c, 415, 'unsupported_media_type', 'Send JSON with content-type: application/json.') };
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: fail(c, 400, 'invalid_json', 'The request body is not valid JSON.') };
  }
  const parsed = parse(check, raw);
  if (!parsed.ok) return { ok: false, response: fail(c, 400, 'invalid_request', parsed.errors[0]!, { errors: parsed.errors }) };
  return { ok: true, value: parsed.value };
}

/** The client's address. Behind a trusted proxy, the first X-Forwarded-For hop. In-process test requests have none. */
export function clientAddress(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? 'in-process';
  } catch {
    return 'in-process';
  }
}

export const isLoopbackAddress = (address: string) =>
  address === 'in-process' || address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Is this Origin the server itself (by Host header) or one of the configured extra origins? */
export function originAllowed(origin: string, host: string | undefined, allowed: string[]): boolean {
  if (origin === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (host && parsed.host.toLowerCase() === host.toLowerCase()) return true;
  return allowed.includes(`${parsed.protocol}//${parsed.host}`.toLowerCase()) || allowed.includes(origin.toLowerCase());
}
