import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The built-in `node:sqlite` database, so the repo installs on Node 24 without a
 * native toolchain. `better-sqlite3` needed node-gyp and Visual Studio C++.
 */
export type Db = DatabaseSync;

/**
 * Bump whenever what Kev is told changes without changing the decisionKey
 * (see `buildSystemOneRequest`). The key is frozen in the contract, so old
 * answers would otherwise keep matching and Kev would never see the new state.
 * Regenerate `decision-seed.json` in the same change, or the stale seed is
 * reloaded into the freshly emptied cache.
 * 2: added each fan type's compliance.
 */
export const DECISION_CACHE_VERSION = 2;

/** Plans, saved comparisons and the decision cache. The cache is what makes a warm run fast. */
export function openDb(path = process.env.DB_PATH ?? './data/gameday.db'): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    create table if not exists plans (
      id text primary key,
      incident text not null,
      json text not null
    );
    create table if not exists comparisons (
      id text primary key,
      json text not null,
      created_at integer not null
    );
    create table if not exists decision_cache (
      key text primary key,
      odds text not null,
      model text,
      ms integer,
      created_at integer not null
    );
  `);
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version < DECISION_CACHE_VERSION) {
    db.exec('delete from decision_cache');
    db.exec(`PRAGMA user_version = ${DECISION_CACHE_VERSION}`);
  }
  seedDecisions(db);
  return db;
}

interface SeedRow {
  key: string;
  odds: string;
  model: string | null;
  ms: number | null;
}

/**
 * Answers the real Kev-4B already gave, shipped with the repo.
 *
 * Kev answers in roughly 250 ms, so a scenario met for the very first time
 * cannot have more than a handful of its keys answered inside the engine's 2 s
 * pause, and the rest fall back. That is the contract working as written, but
 * it means a fresh clone's first run is mostly guesses. Seeding the cache from
 * real answers means the demo is model-driven from the first click instead,
 * and the fallback path is still there for anything these do not cover.
 *
 * Regenerate with `npm run warm` against a live Kev, then `npm run seed:export`.
 */
export function seedDecisions(db: Db): number {
  const already = (db.prepare('select count(*) as n from decision_cache').get() as { n: number }).n;
  if (already > 0) return 0;

  let rows: SeedRow[];
  try {
    // `join` builds the path with the platform's separator, so this resolves on
    // Windows (`\`) and POSIX (`/`) alike.
    const seedPath = join(import.meta.dirname, '..', 'data', 'decision-seed.json');
    rows = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedRow[];
  } catch {
    return 0; // no seed shipped, or unreadable: start cold, which still works
  }

  const insert = db.prepare(
    'insert or ignore into decision_cache (key, odds, model, ms, created_at) values (?, ?, ?, ?, ?)',
  );
  const now = Date.now();
  // `node:sqlite` has no `.transaction()` helper; one BEGIN/COMMIT around the
  // whole seed keeps it to a single fsync, and ROLLBACK keeps it all-or-nothing.
  db.exec('BEGIN');
  try {
    for (const row of rows) insert.run(row.key, row.odds, row.model, row.ms, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return rows.length;
}
