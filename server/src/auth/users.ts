import { randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import type { Actor, ActorGrant, Grant, Position } from '../types.ts';
import { POSITIONS } from '../types.ts';
import { iso } from '../platform/canonical.ts';

/**
 * Accounts and the positions they hold. An account carries a username and a
 * display name and nothing else about the person: no email, no phone, no
 * badge number (research 06 §2.5 "staff personal ... minimal").
 */
export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  totp_secret: string | null;
  totp_pending: string | null;
  totp_last_step: number | null;
  idp: string;
  idp_subject: string | null;
  disabled: number;
  created_at: number;
  updated_at: number;
}

interface GrantRow {
  id: string;
  user_id: string;
  position: string;
  scope: string;
  unit: string | null;
  granted_by: string;
  granted_at: number;
}

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/i;
export const SCOPE_PATTERN = /^(\*|[a-z0-9][a-z0-9._-]{0,63})$/;

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  disabled: boolean;
  mfaEnrolled: boolean;
  idp: string;
  createdAt: string;
  grants: Grant[];
}

const toGrant = (row: GrantRow): Grant => ({
  id: row.id,
  userId: row.user_id,
  position: row.position as Position,
  scope: row.scope,
  unit: row.unit,
  grantedBy: row.granted_by,
  grantedAt: iso(row.granted_at),
});

export class Users {
  private cachedCount: number | null = null;
  private readonly grantListeners = new Set<(userId: string) => void>();

  private readonly db: Db;
  private readonly now: () => number;
  constructor(
    db: Db,
    now: () => number = Date.now,
  ) {
    this.db = db;
    this.now = now;
  }

  count(): number {
    this.cachedCount ??= (this.db.prepare('select count(*) as n from users').get() as { n: number }).n;
    return this.cachedCount;
  }

  byId(id: string): UserRow | undefined {
    return this.db.prepare('select * from users where id = ?').get(id) as UserRow | undefined;
  }

  byUsername(username: string): UserRow | undefined {
    return this.db.prepare('select * from users where username = ? collate nocase').get(username) as UserRow | undefined;
  }

  create(input: { username: string; displayName: string; passwordHash: string | null; idp?: string; idpSubject?: string | null }): UserRow {
    if (!USERNAME_PATTERN.test(input.username)) throw new Error('username must be 3-40 letters, digits, dots, dashes or underscores');
    const now = this.now();
    const id = randomUUID();
    this.db
      .prepare('insert into users (id, username, display_name, password_hash, idp, idp_subject, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.username, input.displayName.slice(0, 80), input.passwordHash, input.idp ?? 'local', input.idpSubject ?? null, now, now);
    this.cachedCount = null;
    return this.byId(id)!;
  }

  update(id: string, fields: Partial<Pick<UserRow, 'display_name' | 'password_hash' | 'totp_secret' | 'totp_pending' | 'totp_last_step' | 'disabled'>>): void {
    const entries = Object.entries(fields);
    if (!entries.length) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    this.db.prepare(`update users set ${sets}, updated_at = ? where id = ?`).run(...(entries.map(([, v]) => v) as (string | number | null)[]), this.now(), id);
  }

  list(): PublicUser[] {
    const users = this.db.prepare('select * from users order by username').all() as unknown as UserRow[];
    return users.map((u) => this.toPublic(u));
  }

  toPublic(u: UserRow): PublicUser {
    return {
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      disabled: Boolean(u.disabled),
      mfaEnrolled: Boolean(u.totp_secret),
      idp: u.idp,
      createdAt: iso(u.created_at),
      grants: this.grants(u.id),
    };
  }

  grants(userId: string): Grant[] {
    return (this.db.prepare('select * from grants where user_id = ? and revoked_at is null order by granted_at, id').all(userId) as unknown as GrantRow[]).map(toGrant);
  }

  grantsIn(scope?: string): Grant[] {
    const rows = scope
      ? this.db.prepare('select * from grants where revoked_at is null and (scope = ? or scope = ?) order by granted_at').all(scope, '*')
      : this.db.prepare('select * from grants where revoked_at is null order by granted_at').all();
    return (rows as unknown as GrantRow[]).map(toGrant);
  }

  grant(input: { userId: string; position: Position; scope: string; unit?: string | null; grantedBy: string }): Grant {
    if (!(POSITIONS as readonly string[]).includes(input.position)) throw new Error('unknown position');
    if (!SCOPE_PATTERN.test(input.scope)) throw new Error('scope must be * or a lower-case id');
    const existing = this.grants(input.userId).find((g) => g.position === input.position && g.scope === input.scope && (g.unit ?? null) === (input.unit ?? null));
    if (existing) return existing;
    const id = randomUUID();
    this.db
      .prepare('insert into grants (id, user_id, position, scope, unit, granted_by, granted_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.userId, input.position, input.scope, input.unit ?? null, input.grantedBy, this.now());
    this.emitGrants(input.userId);
    return toGrant(this.db.prepare('select * from grants where id = ?').get(id) as unknown as GrantRow);
  }

  revokeGrant(id: string, by: string): Grant | null {
    const row = this.db.prepare('select * from grants where id = ? and revoked_at is null').get(id) as GrantRow | undefined;
    if (!row) return null;
    this.db.prepare('update grants set revoked_at = ?, revoked_by = ? where id = ?').run(this.now(), by, id);
    this.emitGrants(row.user_id);
    return toGrant(row);
  }

  /** Called whenever someone's grants change, so open sockets can re-check what they may see. */
  onGrantsChanged(listener: (userId: string) => void): () => void {
    this.grantListeners.add(listener);
    return () => this.grantListeners.delete(listener);
  }

  emitGrants(userId: string): void {
    for (const listener of this.grantListeners) listener(userId);
  }

  actorFor(user: UserRow, sessionId?: string): Actor {
    const grants: ActorGrant[] = this.grants(user.id).map((g) => ({ position: g.position, scope: g.scope, unit: g.unit }));
    return { userId: user.id, username: user.username, displayName: user.display_name, kind: 'user', grants, sessionId };
  }
}
