import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import { iso, randomToken, sha256Hex } from '../platform/canonical.ts';

/**
 * Server-side sessions (research 06 §2.2, PLT-09).
 *
 * The browser holds a random 256-bit token in an HttpOnly, SameSite=Strict
 * cookie (Secure when TLS is on); the database holds only its SHA-256, so a
 * copied database file contains no live sessions. A session ends at its
 * absolute deadline (≤24 h) or after the idle limit (≤1 h) without a request,
 * whichever comes first, and a revocation is pushed to listeners so open
 * WebSockets close at once.
 */
export type SessionKind = 'user' | 'display';
export type SessionStage = 'full' | 'mfa_enrolment';

export interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  kind: SessionKind;
  csrf: string;
  stage: SessionStage;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_reason: string | null;
}

export type Resolved =
  | { state: 'ok'; session: SessionRow }
  | { state: 'expired' | 'idle' | 'revoked' | 'unknown'; session?: SessionRow };

export interface PublicSession {
  id: string;
  userId: string;
  kind: SessionKind;
  stage: SessionStage;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

/** Writes to last_seen_at are throttled: idle is measured to within this much. */
const TOUCH_EVERY_MS = 15_000;

export class Sessions {
  private readonly listeners = new Set<(session: SessionRow, reason: string) => void>();

  private readonly db: Db;
  private readonly policy: { absoluteMs: number; idleMs: number };
  private readonly now: () => number;
  constructor(
    db: Db,
    policy: { absoluteMs: number; idleMs: number },
    now: () => number = Date.now,
  ) {
    this.db = db;
    this.policy = policy;
    this.now = now;
  }

  get absoluteMs() {
    return this.policy.absoluteMs;
  }
  get idleMs() {
    return this.policy.idleMs;
  }

  create(userId: string, kind: SessionKind = 'user', stage: SessionStage = 'full', absoluteMs = this.policy.absoluteMs): { token: string; session: SessionRow } {
    const token = randomToken(32);
    const now = this.now();
    const session: SessionRow = {
      id: randomUUID(),
      token_hash: sha256Hex(token),
      user_id: userId,
      kind,
      csrf: randomToken(32),
      stage,
      created_at: now,
      last_seen_at: now,
      expires_at: now + Math.min(absoluteMs, this.policy.absoluteMs),
      revoked_at: null,
      revoked_reason: null,
    };
    this.db
      .prepare('insert into sessions (id, token_hash, user_id, kind, csrf, stage, created_at, last_seen_at, expires_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(session.id, session.token_hash, session.user_id, session.kind, session.csrf, session.stage, session.created_at, session.last_seen_at, session.expires_at);
    return { token, session };
  }

  /** Look a token up, enforcing both deadlines. A live session's idle clock restarts. */
  resolve(token: string | undefined, touch = true): Resolved {
    if (!token || token.length > 200) return { state: 'unknown' };
    const session = this.db.prepare('select * from sessions where token_hash = ?').get(sha256Hex(token)) as SessionRow | undefined;
    return this.check(session, touch);
  }

  byId(id: string): SessionRow | undefined {
    return this.db.prepare('select * from sessions where id = ?').get(id) as SessionRow | undefined;
  }

  /** Re-check a session already resolved (for sockets that outlive the request that opened them). */
  check(session: SessionRow | undefined, touch = false): Resolved {
    if (!session) return { state: 'unknown' };
    const current = this.byId(session.id);
    if (!current) return { state: 'unknown' };
    if (current.revoked_at !== null) return { state: 'revoked', session: current };
    const now = this.now();
    if (now >= current.expires_at) {
      this.revoke(current.id, 'expired');
      return { state: 'expired', session: current };
    }
    if (now - current.last_seen_at >= this.policy.idleMs) {
      this.revoke(current.id, 'idle');
      return { state: 'idle', session: current };
    }
    if (touch) this.touch(current, now);
    return { state: 'ok', session: current };
  }

  touch(session: SessionRow, now = this.now()): void {
    if (now - session.last_seen_at < TOUCH_EVERY_MS) return;
    this.db.prepare('update sessions set last_seen_at = ? where id = ? and revoked_at is null').run(now, session.id);
    session.last_seen_at = now;
  }

  revoke(id: string, reason: string): boolean {
    const session = this.byId(id);
    if (!session || session.revoked_at !== null) return false;
    this.db.prepare('update sessions set revoked_at = ?, revoked_reason = ? where id = ? and revoked_at is null').run(this.now(), reason, id);
    for (const listener of this.listeners) listener(session, reason);
    return true;
  }

  revokeAllForUser(userId: string, reason: string, exceptId?: string): number {
    const live = this.db.prepare('select id from sessions where user_id = ? and revoked_at is null').all(userId) as { id: string }[];
    let n = 0;
    for (const { id } of live) if (id !== exceptId && this.revoke(id, reason)) n++;
    return n;
  }

  onRevoked(listener: (session: SessionRow, reason: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(userId?: string, includeEnded = false): PublicSession[] {
    const where = [userId ? 'user_id = ?' : null, includeEnded ? null : 'revoked_at is null'].filter(Boolean).join(' and ');
    const rows = this.db.prepare(`select * from sessions ${where ? `where ${where}` : ''} order by created_at desc limit 500`).all(...(userId ? [userId] : [])) as unknown as SessionRow[];
    return rows.map((r) => this.toPublic(r));
  }

  toPublic(r: SessionRow): PublicSession {
    return {
      id: r.id,
      userId: r.user_id,
      kind: r.kind,
      stage: r.stage,
      createdAt: iso(r.created_at),
      lastSeenAt: iso(r.last_seen_at),
      absoluteExpiresAt: iso(r.expires_at),
      idleExpiresAt: iso(Math.min(r.expires_at, r.last_seen_at + this.policy.idleMs)),
      revokedAt: r.revoked_at === null ? null : iso(r.revoked_at),
      revokedReason: r.revoked_reason,
    };
  }
}

/** `__Host-` pins the cookie to this host and path `/` with Secure; only possible over TLS. */
export const cookieName = (secure: boolean) => (secure ? '__Host-gd_session' : 'gd_session');

export function sessionCookie(token: string, maxAgeS: number, secure: boolean): string {
  return [`${cookieName(secure)}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.max(0, Math.floor(maxAgeS))}`, ...(secure ? ['Secure'] : [])].join('; ');
}

export const clearSessionCookie = (secure: boolean) => sessionCookie('', 0, secure);

export function readCookie(header: string | undefined | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}
