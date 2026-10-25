/**
 * Export the decision cache to the seed the repo ships (`server/data/decision-seed.json`).
 *
 * Kev answers are expensive and a scenario met for the first time cannot have
 * more than a handful of its keys answered inside the engine's 2 s pause, so the
 * answers the real Kev-4B already gave ship with the repo and `openDb()` loads
 * them into an empty cache. Regenerate after changing fan types, situations or
 * the `decisionKey` context, because those change the keys and the old answers
 * stop matching.
 *
 *   npm run warm                              # against a live Kev, fills DB_PATH
 *   $env:DB_PATH = './data/gameday.db'; npm run seed:export
 *
 * Contract:
 * - Input: the `decision_cache` table of the SQLite file named by `DB_PATH`
 *   (the same variable `openDb()` reads), opened with the built-in `node:sqlite`
 *   so this runs on Windows without the `sqlite3` CLI or bash `$DB_PATH` syntax.
 * - Output: a JSON array of `{ key, odds, model, ms }` ordered by `key`
 *   (SQLite's binary collation, which is what the SQL used to ask for) —
 *   `odds` stays the raw JSON string the cache stores. One row per line and a
 *   trailing newline, the layout `sqlite3 -json` used to print, so regenerating
 *   the seed is a content diff rather than a whole-file rewrite.
 *   `seedDecisions()` parses it back either way.
 * - Destination: `server/data/decision-seed.json`.
 * - Verification override: pass an output path as the first argument, or set
 *   `SEED_OUT`, to write somewhere else and leave the shipped seed untouched:
 *
 *     $env:DB_PATH = '<temp>.db'; $env:SEED_OUT = '<temp>.json'; npm run seed:export
 *
 * - Exits non-zero, with a message saying what is wrong, if `DB_PATH` is unset,
 *   the file is missing, the table cannot be read, or the table is empty (an
 *   export of nothing would delete the shipped answers).
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface SeedRow {
  key: string;
  odds: string;
  model: string | null;
  ms: number | null;
}

function fail(message: string): never {
  console.error(`seed:export: ${message}`);
  process.exit(1);
}

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  fail(
    'DB_PATH is not set. Point it at the database to export, e.g.\n' +
      "  $env:DB_PATH = './data/gameday.db'; npm run seed:export",
  );
}

const outPath =
  process.argv[2] ??
  process.env.SEED_OUT ??
  join(import.meta.dirname, '..', 'server', 'data', 'decision-seed.json');

// `DatabaseSync` creates a missing file, so a typo would otherwise export an
// empty table instead of telling the operator the path is wrong.
if (!existsSync(dbPath)) fail(`no database at ${dbPath}`);

let rows: SeedRow[] = [];
let db: DatabaseSync | undefined;
try {
  db = new DatabaseSync(dbPath);
  const table = db
    .prepare("select name from sqlite_master where type = 'table' and name = 'decision_cache'")
    .get();
  if (!table) fail(`${dbPath} has no decision_cache table — is this a gameday database?`);
  rows = db
    .prepare('select key, odds, model, ms from decision_cache order by key')
    .all() as unknown as SeedRow[];
} catch (error) {
  fail(`could not read decision_cache from ${dbPath}: ${(error as Error).message}`);
} finally {
  db?.close();
}

if (rows.length === 0) {
  fail(`decision_cache in ${dbPath} is empty; nothing to export (the shipped seed was left alone).`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, '[' + rows.map((row) => JSON.stringify(row)).join(',\n') + ']\n');
console.log(`seed:export: wrote ${rows.length} rows from ${dbPath} to ${outPath}`);
