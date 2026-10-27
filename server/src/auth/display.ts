import { randomInt, randomUUID } from 'node:crypto';
import type { Db } from '../db.ts';
import { iso, sha256Hex } from '../platform/canonical.ts';

/**
 * Read-only display grants for wallboards (research 06 §2.2, PLT-09).
 *
 * A commander (or anyone with `display.manage` in the event) creates a grant
 * for one screen and one event; the server shows a one-time pairing code
 * (valid ten minutes) that the wallboard enters once. The wallboard then
 * holds a session with the read-only `display` position in that event only.
 * Its idle clock is kept running by its WebSocket heartbeat rather than by a
 * person, so it does not lock mid-incident, but the 24 h ceiling still holds,
 * and revoking the grant closes the screen at once.
 */
export interface DisplayGrant {
  id: string;
  scope: string;
  label: string;
  createdBy: string;
  createdAt: string;
  pairedAt: string | null;
  revokedAt: string | null;
}

interface Row {
  id: string;
  scope: string;
  label: string;
  code_hash: string;
  code_expires_at: number;
  paired_at: number | null;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
}

const toGrant = (r: Row): DisplayGrant => ({
  id: r.id,
  scope: r.scope,
  label: r.label,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  pairedAt: r.paired_at === null ? null : iso(r.paired_at),
  revokedAt: r.revoked_at === null ? null : iso(r.revoked_at),
});

export const PAIRING_TTL_MS = 10 * 60_000;
export const DISPLAY_USER_PREFIX = 'display:';

export class DisplayGrants {
  private readonly db: Db;
  private readonly now: () => number;
  constructor(
    db: Db,
    now: () => number = Date.now,
  ) {
    this.db = db;
    this.now = now;
  }

  create(input: { scope: string; label: string; createdBy: string }): { grant: DisplayGrant; code: string } {
    const id = randomUUID();
    // Ten digits in two groups: easy to type on a TV remote, 2^33 guesses, and login throttling applies.
    const code = `${randomInt(0, 100000).toString().padStart(5, '0')}-${randomInt(0, 100000).toString().padStart(5, '0')}`;
    const now = this.now();
    this.db
      .prepare('insert into display_grants (id, scope, label, code_hash, code_expires_at, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.scope, input.label.slice(0, 80), sha256Hex(code), now + PAIRING_TTL_MS, input.createdBy, now);
    return { grant: this.get(id)!, code };
  }

  get(id: string): DisplayGrant | null {
    const row = this.db.prepare('select * from display_grants where id = ?').get(id) as Row | undefined;
    return row ? toGrant(row) : null;
  }

  live(id: string): DisplayGrant | null {
    const grant = this.get(id);
    return grant && !grant.revokedAt ? grant : null;
  }

  /** Exchange a pairing code once. */
  pair(code: string): DisplayGrant | null {
    const row = this.db.prepare('select * from display_grants where code_hash = ? and revoked_at is null and paired_at is null').get(sha256Hex(code.trim())) as Row | undefined;
    if (!row || this.now() > row.code_expires_at) return null;
    this.db.prepare('update display_grants set paired_at = ? where id = ?').run(this.now(), row.id);
    return this.get(row.id);
  }

  list(scope?: string): DisplayGrant[] {
    const rows = (scope ? this.db.prepare('select * from display_grants where scope = ? order by created_at desc').all(scope) : this.db.prepare('select * from display_grants order by created_at desc').all()) as unknown as Row[];
    return rows.map(toGrant);
  }

  revoke(id: string): DisplayGrant | null {
    const grant = this.live(id);
    if (!grant) return null;
    this.db.prepare('update display_grants set revoked_at = ? where id = ?').run(this.now(), id);
    return this.get(id);
  }
}
