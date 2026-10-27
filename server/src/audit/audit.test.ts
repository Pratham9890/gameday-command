import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db.ts';
import { migratePlatform } from '../platform/schema.ts';
import { chainHash } from '../platform/canonical.ts';
import { AuditLog, loadAuditKey, sanitizeDetail } from './audit.ts';
import { FakeClock, addUser, makeApp, signIn } from '../testing.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fresh(checkpointEvery = 100) {
  const db = openDb(':memory:');
  migratePlatform(db);
  const clock = new FakeClock();
  const log = new AuditLog(db, { key: loadAuditKey(null), checkpointEvery, now: clock.now });
  for (let i = 0; i < 10; i++) {
    clock.advance(1000);
    log.append({ actor: { userId: 'u1', name: 'ic.one', position: 'incident_commander' }, action: i % 2 ? 'document.approve' : 'auth.login', target: `t${i}`, detail: { n: i } });
  }
  return { db, log, clock };
}

/** What an attacker with the database file can do: drop the triggers, then edit. */
const unprotect = (db: Db) => {
  db.exec('drop trigger audit_log_append_only_update; drop trigger audit_log_append_only_delete;');
};

describe('the hash-chained audit log', () => {
  it('chains every entry to the one before and verifies clean', () => {
    const { log } = fresh();
    const entries = log.list();
    expect(entries).toHaveLength(10);
    expect(entries[0]!.prevHash).toBe('0'.repeat(64));
    for (let i = 1; i < entries.length; i++) expect(entries[i]!.prevHash).toBe(entries[i - 1]!.hash);
    const result = log.verify();
    expect(result).toMatchObject({ ok: true, entries: 10, lastSeq: 10, problems: [] });
  });

  it('refuses UPDATE and DELETE through SQLite triggers', () => {
    const { db } = fresh();
    expect(() => db.prepare("update audit_log set outcome = 'success' where seq = 3").run()).toThrow(/append-only/);
    expect(() => db.prepare('delete from audit_log where seq = 3').run()).toThrow(/append-only/);
  });

  it('detects an edited entry', () => {
    const { db, log } = fresh();
    unprotect(db);
    db.prepare("update audit_log set target = 'someone-else' where seq = 4").run();
    const result = log.verify();
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual(expect.objectContaining({ seq: 4, kind: 'hash_mismatch' }));
  });

  it('detects a deleted entry', () => {
    const { db, log } = fresh();
    unprotect(db);
    db.prepare('delete from audit_log where seq = 5').run();
    const kinds = log.verify().problems.map((p) => [p.seq, p.kind]);
    expect(kinds).toContainEqual([5, 'gap']);
    expect(kinds).toContainEqual([6, 'broken_link']);
  });

  it('detects a rewritten chain through the signed checkpoints', () => {
    const { db, log } = fresh(5);
    expect(log.checkpoints().map((c) => c.seq)).toEqual([5, 10]);
    unprotect(db);
    // Rewrite entry 3 and recompute every hash after it, as a careful attacker would.
    const rows = db.prepare('select * from audit_log order by seq').all() as Record<string, unknown>[];
    let prev = '0'.repeat(64);
    for (const row of rows) {
      const detail = row.seq === 3 ? '{"n":999}' : (row.detail as string);
      const fields = { seq: row.seq, at: row.at, actor: { userId: row.actor_user, name: row.actor_name, position: row.actor_position }, action: row.action, target: row.target, outcome: row.outcome, detail: JSON.parse(detail) };
      const hash = chainHash(prev, fields);
      db.prepare('update audit_log set detail = ?, prev_hash = ?, hash = ? where seq = ?').run(detail, prev, hash, row.seq as number);
      prev = hash;
    }
    const result = log.verify();
    expect(result.ok).toBe(false);
    expect(result.problems.filter((p) => p.kind === 'checkpoint_mismatch').map((p) => p.seq)).toEqual([5, 10]);
    expect(result.problems.some((p) => p.kind === 'hash_mismatch')).toBe(false);
  });

  it('detects truncation of the tail', () => {
    const { db, log } = fresh(5);
    unprotect(db);
    db.prepare('delete from audit_log where seq > 7').run();
    expect(log.verify().problems).toContainEqual(expect.objectContaining({ seq: 10, kind: 'truncated' }));
  });

  it('refuses checkpoints signed by a key it does not trust, or with a broken signature', () => {
    const { db, log } = fresh(5);
    const intruder = new AuditLog(db, { key: loadAuditKey(null) });
    intruder.checkpoint();
    db.prepare("update audit_checkpoints set signature = 'AAAA' where seq = 5").run();
    const kinds = log.verify().problems.map((p) => [p.seq, p.kind]);
    expect(kinds).toContainEqual([10, 'untrusted_key']);
    expect(kinds).toContainEqual([5, 'bad_signature']);
  });

  it('keeps the signing key in its own file, 0600, and reloads the same key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-audit-'));
    dirs.push(dir);
    const file = join(dir, 'keys', 'audit-ed25519.pem');
    const first = loadAuditKey(file);
    expect(readFileSync(file, 'utf8')).toMatch(/BEGIN PRIVATE KEY/);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadAuditKey(file).keyId).toBe(first.keyId);
  });

  it('never keeps secrets or long free text in the detail', () => {
    expect(sanitizeDetail({ password: 'hunter2', totpCode: '123456', csrf: 'x', token: 'y', scope: 'osu-2026', n: 3, ok: true, nested: { a: 1 } as never })).toEqual({ scope: 'osu-2026', n: 3, ok: true });
    expect(String(sanitizeDetail({ note: 'x'.repeat(500) }).note)).toHaveLength(161);
  });
});

describe('audit over HTTP', () => {
  it('records sign-ins, lets records and admin verify, and keeps it from operational staff', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'records.one', [{ position: 'records', scope: '*' }]);
    await addUser(platform, 'ic.one', [{ position: 'incident_commander' }]);
    const records = await signIn(app, 'records.one');
    const ic = await signIn(app, 'ic.one');
    expect((await ic.get('/api/v3/audit')).status).toBe(403);
    const verify = await records.json('GET', '/api/v3/audit/verify');
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ ok: true, eventLog: { ok: true } });
    const log = (await records.json('GET', '/api/v3/audit')).body as { action: string; actor: { name: string } }[];
    expect(log.filter((e) => e.action === 'auth.login').map((e) => e.actor.name)).toEqual(['records.one', 'ic.one']);
  });

  it('gives the vision workstream a video-view hook, only for positions that may view video', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'rtcc.one', [{ position: 'rtcc_analyst' }]);
    await addUser(platform, 'pio.one', [{ position: 'pio' }]);
    const rtcc = await signIn(app, 'rtcc.one');
    const pio = await signIn(app, 'pio.one');
    expect((await rtcc.post('/api/v3/audit/video-views', { scope: 'osu-2026', feedId: 'cam-gate-10', action: 'start', zones: 4 })).status).toBe(201);
    expect((await rtcc.post('/api/v3/audit/video-views', { scope: 'osu-2026', feedId: 'cam-gate-10', action: 'stop' })).status).toBe(201);
    expect((await pio.post('/api/v3/audit/video-views', { scope: 'osu-2026', feedId: 'cam-gate-10', action: 'start' })).status).toBe(403);
    const views = platform.audit.list().filter((e) => e.action.startsWith('video.view'));
    expect(views.map((e) => [e.action, e.target, e.actor.position])).toEqual([
      ['video.view.start', 'cam-gate-10', 'rtcc_analyst'],
      ['video.view.stop', 'cam-gate-10', 'rtcc_analyst'],
    ]);
  });
});
