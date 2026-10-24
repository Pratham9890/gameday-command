import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

/** Plans, saved comparisons and the decision cache. The cache is what makes a warm run fast. */
export function openDb(path = process.env.DB_PATH ?? './data/gameday.db'): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
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
  return db;
}
