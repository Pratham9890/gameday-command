/**
 * Freezes the server's read-only routes into static JSON for a hosted build.
 *
 * A hosted deployment has no long-running server: maps are ~6 MB each, over a
 * serverless function's response limit, and SQLite needs a writable disk. So the
 * GET routes the app needs are asked of the real server app once, in-process,
 * and written under app/dist/static-api; vercel.json rewrites /api/... onto them.
 * Decisions come from api/decide.js (the shipped Kev cache); anything else the
 * hosted app asks for falls back exactly as it does when the server is down.
 *
 *   node scripts/static-api.ts      (after npm run build)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IncidentKind } from '../contracts.ts';
import { openDb } from '../server/src/db.ts';
import { createApp } from '../server/src/index.ts';

const OUT = resolve('app/dist/static-api');
const KINDS: IncidentKind[] = ['game_end', 'lightning_delay', 'gate_surge', 'suspicious_package', 'medical', 'fight'];

const app = createApp(openDb(':memory:'));

async function save(route: string, file: string): Promise<unknown> {
  const res = await app.request(route);
  if (!res.ok) throw new Error(`${route} returned ${res.status}`);
  const text = await res.text();
  const path = resolve(OUT, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`${route} -> static-api/${file} (${(text.length / 1e6).toFixed(2)} MB)`);
  return JSON.parse(text);
}

const maps = (await save('/api/maps', 'maps.json')) as { id: string }[];
for (const { id } of maps) await save(`/api/maps/${id}`, `maps/${id}.json`);
await save('/api/maps/default', 'maps/default.json');
await save('/api/decision-defaults', 'decision-defaults.json');
for (const kind of KINDS) await save(`/api/plans?incident=${kind}`, `plans/${kind}.json`);
writeFileSync(resolve(OUT, 'empty.json'), '[]');
