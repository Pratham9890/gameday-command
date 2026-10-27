/**
 * Test helpers for the platform: an app on an in-memory database with a fake
 * clock and fast scrypt, accounts with positions, and a cookie-carrying
 * client that sends the CSRF token the way the browser client does.
 */
import type { Hono } from 'hono';
import { openDb, type Db } from './db.ts';
import { createApp, platformOf } from './index.ts';
import { testConfig, type PlatformConfig } from './platform/config.ts';
import type { Platform, PlatformOptions } from './platform/platform.ts';
import type { AppEnv } from './platform/http.ts';
import type { Position } from './types.ts';
import { hashPassword } from './auth/password.ts';
import { totp, base32Decode } from './auth/totp.ts';

export class FakeClock {
  t: number;
  constructor(start = Date.parse('2026-10-31T16:00:00Z')) {
    this.t = start;
  }
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export interface TestApp {
  app: Hono<AppEnv>;
  platform: Platform;
  db: Db;
  clock: FakeClock;
}

export function makeApp(config: Partial<PlatformConfig> = {}, opts: PlatformOptions & { db?: Db; clock?: FakeClock } = {}): TestApp {
  const clock = opts.clock ?? new FakeClock();
  const db = opts.db ?? openDb(':memory:');
  const app = createApp(db, { ...opts, now: opts.now ?? clock.now, config: testConfig({ mfa: 'optional', ...config }) });
  return { app, platform: platformOf(app), db, clock };
}

export const PASSWORD = 'correct horse battery staple';

export async function addUser(platform: Platform, username: string, grants: { position: Position; scope?: string; unit?: string }[] = [], password = PASSWORD) {
  const user = platform.users.create({ username, displayName: `${username} (test)`, passwordHash: await hashPassword(password, platform.config.scrypt) });
  for (const g of grants) platform.users.grant({ userId: user.id, position: g.position, scope: g.scope ?? 'osu-2026', unit: g.unit ?? null, grantedBy: 'test' });
  return user;
}

export interface Client {
  cookie: string | null;
  csrf: string | null;
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  put(path: string, body?: unknown): Promise<Response>;
  del(path: string): Promise<Response>;
  json<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
}

export function client(app: Hono<AppEnv>): Client {
  const c: Client = {
    cookie: null,
    csrf: null,
    async request(method, path, body, headers = {}) {
      const res = await app.request(path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(c.cookie ? { cookie: c.cookie } : {}),
          ...(c.csrf && method !== 'GET' ? { 'x-csrf-token': c.csrf } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.get('set-cookie');
      if (set) {
        const match = /(?:__Host-)?gd_session=([^;]*)/.exec(set);
        if (match) c.cookie = match[1] ? `${set.startsWith('__Host-') ? '__Host-' : ''}gd_session=${match[1]}` : null;
      }
      return res;
    },
    get: (path) => c.request('GET', path),
    post: (path, body, headers) => c.request('POST', path, body ?? {}, headers),
    put: (path, body) => c.request('PUT', path, body ?? {}),
    del: (path) => c.request('DELETE', path),
    async json(method, path, body) {
      const res = await c.request(method, path, body);
      return { status: res.status, body: (await res.json()) as never };
    },
  };
  return c;
}

/** Sign in and remember the cookie and CSRF token. */
export async function signIn(app: Hono<AppEnv>, username: string, password = PASSWORD, code?: string): Promise<Client> {
  const c = client(app);
  const res = await c.post('/api/v3/auth/login', { username, password, ...(code ? { totp: code } : {}) });
  if (res.status !== 200) throw new Error(`sign-in for ${username} failed: ${res.status} ${await res.text()}`);
  const info = (await res.json()) as { csrfToken: string };
  c.csrf = info.csrfToken;
  return c;
}

export const codeFor = (secret: string, at: number) => totp(base32Decode(secret), at);
