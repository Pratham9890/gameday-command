import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DECISION_CACHE_VERSION, openDb } from './db.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('decision cache version', () => {
  it('drops answers cached under an older version of what Kev is told', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-db-'));
    dirs.push(dir);
    const path = join(dir, 'gameday.db');

    const old = openDb(path);
    old.prepare('insert or replace into decision_cache (key, odds, model, ms, created_at) values (?, ?, ?, ?, ?)')
      .run('stale-key', '{"follow":1,"ignore":0}', 'kev-4b', 200, 0);
    old.pragma('user_version = 0');
    old.close();

    const db = openDb(path);
    expect(db.prepare('select key from decision_cache where key = ?').get('stale-key')).toBeUndefined();
    expect(db.pragma('user_version', { simple: true })).toBe(DECISION_CACHE_VERSION);
    db.close();
  });

  it('keeps answers cached under the current version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-db-'));
    dirs.push(dir);
    const path = join(dir, 'gameday.db');

    const first = openDb(path);
    first.prepare('insert or replace into decision_cache (key, odds, model, ms, created_at) values (?, ?, ?, ?, ?)')
      .run('fresh-key', '{"follow":1,"ignore":0}', 'kev-4b', 200, 0);
    first.close();

    const db = openDb(path);
    expect(db.prepare('select key from decision_cache where key = ?').get('fresh-key')).toBeDefined();
    db.close();
  });
});
