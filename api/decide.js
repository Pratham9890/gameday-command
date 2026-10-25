// Hosted /api/decide: answers from the shipped Kev cache (server/data/decision-seed.json).
// A key the cache has never seen gets no answer, and the brain client takes the
// default for it with source 'default', exactly as when the local server is down.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let cache;
function load() {
  if (!cache) {
    const rows = JSON.parse(readFileSync(resolve(process.cwd(), 'server/data/decision-seed.json'), 'utf8'));
    cache = new Map(rows.map((r) => [r.key, r]));
  }
  return cache;
}

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const asks = (req.body && req.body.asks) || [];
  const rows = load();
  const answers = [];
  for (const ask of asks) {
    const row = rows.get(ask.key);
    if (row) answers.push({ key: ask.key, odds: JSON.parse(row.odds), source: 'cache', model: row.model ?? undefined, ms: row.ms ?? undefined });
  }
  res.status(200).json({ answers });
}
