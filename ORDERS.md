# ORDERS — supervisor → builder

The supervisor (Claude on this PC) reads `CONTEXT.md`, `TODO.md` and `PROMPT.md`, then appends
orders here. The builder (the OpenChamber chat, DeepSeek V4.1 Flash) reads this file when the
user says **"check orders"**, executes open orders, and reports evidence.

## Rules

1. **Append only.** Never rewrite or delete an existing order. The builder appends `result`;
   the supervisor appends `review`.
2. **One order per block**, separated by `---`.
3. **Small enough for one session.** If an order needs more than a day, split it.
4. **State the done condition.** The builder must be able to prove it.
5. **The builder may not edit the order text**, and may not set `verified` or `rejected`.
6. **Priority:** `high` first; within a priority, lowest id first.
7. If an order contradicts `CONTEXT.md` or the frozen contract, stop and say so.
8. The `subagents` field names **OpenChamber** agents only (`explore`, `general`). Claude Code's
   own Task/subagent feature is not used for build or review work here.

## Status values

| status | set by | meaning |
|---|---|---|
| `open` | supervisor | not started |
| `in progress` | builder | being worked |
| `blocked` | builder | cannot finish; reason in `result` |
| `done` | builder | implemented, evidence attached, awaiting review |
| `verified` | supervisor | reviewed and accepted |
| `rejected` | supervisor | reviewed and sent back; reason in `review` |
| `cancelled` | supervisor | no longer wanted |

## Template

```
## ORD-000 — short title

priority: high
status: open
files: path/a.ts, path/b.tsx
subagents: none        # or: explore × 2 · general × 1  (OpenChamber agents only)
do: what to change, in two or three sentences.
done-when: the check that proves it.
depends-on: ORD-000 (optional)
result:
```

---

## ORD-001 — Make the repo install and test on Windows

priority: high
status: verified
files: server/src/db.ts, package.json, server/src/index.ts, server/src/db.test.ts
subagents: explore × 1 (inventory every sqlite use before editing)
do: Replace `better-sqlite3` with the built-in `node:sqlite` (`DatabaseSync`). Keep the schema,
the `user_version` cache reset and `seedDecisions()` behaviour identical. Remove
`better-sqlite3` from `package.json` and from `allowScripts`. Make the `decision-seed.json` path
resolve with either separator on Windows. Do not change `contracts.ts`. Do not touch the app.
done-when: from a clean `node_modules`, `npm install` completes with no Visual Studio and no
node-gyp; `npm run typecheck` is silent; `npm test` is green. Report the exact test-file and
test-case counts, and any live-model tests that skipped.
result:
amendment (supervisor, 2026-10-24): the dependency is declared in `server/package.json`
(`better-sqlite3` and `@types/better-sqlite3`), so that file and `package-lock.json` are in scope
too. `node:sqlite` has no `.pragma()` or `.transaction()`: read `PRAGMA user_version` with
`prepare(...).get()`, set it with `exec`, and wrap the seed insert in `BEGIN`/`COMMIT` (with
`ROLLBACK` on error). Keep `export type Db` so `index.ts` and the tests compile unchanged where
possible. Activate the toolkit first: `. "$env:USERPROFILE\.config\openchamber\toolkit\activate.ps1"`.
Do not commit; leave the change in the working tree for review.

result (builder, 2026-10-24): done — `better-sqlite3` replaced by built-in `node:sqlite` (`DatabaseSync`). Not committed; working tree on `feat/command-v3`.
- Clean install: `node_modules` deleted (confirmed absent), then `npm install` exit 0 → `added 127 packages, and audited 133 packages in 11s`. No node-gyp, no Visual Studio, no native compile. `package-lock.json` no longer contains `better-sqlite3`, `@types/better-sqlite3` or `node-addon-api`. (npm audit reports 3 advisories in the dev-only `vitest`/`tinypool` tree — pre-existing and untouched by this order.)
- `npm run typecheck` (`tsc -p tsconfig.json`) exit 0, no diagnostics.
- `npm test` (`vitest run`) exit 0 → `Test Files  20 passed | 1 skipped (21)`, `Tests  149 passed | 3 skipped (152)`, duration 61.92s. The 3 skipped tests are all of `server/src/live.test.ts`: live Kev on :8009 and `fm serve` on :8080 were not listening, so they skip themselves as designed.
- Seed-path proof: a fresh on-disk DB (temp dir, Windows paths) loaded all 737 shipped seed rows, `PRAGMA user_version` read back 2, and a second `seedDecisions()` returned 0 (idempotency guard intact). The path is now built with `join(import.meta.dirname, '..', 'data', 'decision-seed.json')`, so either separator resolves.
- Changes: `server/src/db.ts` — `DatabaseSync`, WAL via `exec`, `user_version` read with `prepare('PRAGMA user_version').get()` and written with `exec`, seed inserts wrapped in `BEGIN`/`COMMIT` with `ROLLBACK` on error, schema and `DECISION_CACHE_VERSION = 2` unchanged; `server/src/db.test.ts` — `.pragma()` calls translated; `server/src/index.ts` — only the `better-sqlite3` `prepare<...>` generics replaced by result casts, no logic change; `package.json` — `better-sqlite3` dropped from `allowScripts`; `server/package.json` — dependency and `@types/better-sqlite3` dropped; `package-lock.json` — pruned by the clean install.
- Scope note: `server/src/decide.test.ts` needed one line (the `prepare<[string], …>` generic removed, result cast instead), because `node:sqlite` prepares statements untyped; it is not in the order's file list and no assertion changed. `contracts.ts` and `app/` were not touched.

review (supervisor, 2026-10-24): **verified.**
- Read the full diff: changes only in `server/`, `package.json`, `package-lock.json`. The
  `decide.test.ts` scope note is accepted — a type-only change forced by the untyped API.
- Reproduced myself: deleted `node_modules`, `npm install` exit 0, `better-sqlite3` absent;
  `npm run typecheck` silent; `npm test` → 20 passed | 1 skipped files, 149 passed | 3 skipped
  tests (all 3 in `live.test.ts`, Kev and `fm` absent). Numbers match the builder's report.
- Found and fixed a pre-existing Windows bug the order did not cover: `server/src/index.ts`
  started only when `argv[1]` contained `server/src/index.ts` with forward slashes, so on Windows
  `npm run serve` exited silently. Normalised the separators. Smoke test: server up, `GET
  /api/plans?incident=gate_surge` → 200, log reports 737 decisions cached.
- Known leftover, not blocking: `npm run seed:export` shells out to the `sqlite3` CLI with bash
  `$DB_PATH` syntax, so it does not run on Windows. Only needed after a re-warm against Kev.

---

## ORD-002 — Put the ratio and the synthetic-data warning on screen

priority: normal
status: open
files: app/src/App.tsx, app/src/styles.css (plus a small component if needed)
subagents: none
do: Show `1 dot = 5 fans · 20,000 dots · 100,000 fans`, with the numbers derived from the map and
the live dot count, not typed literals. Add a dismissible strip that says crowd, traffic and
sensors are synthetic, and that the forecast is a model output, not an observation. Do not
restyle the app.
done-when: a screenshot shows both; the values come from `fanCount(map)` and the frame's dot
count; typecheck and tests pass.
depends-on: ORD-001
result:

---

## ORD-003 — Make tailgates real destinations

priority: normal
status: open
files: world/src/osm/stadium.ts, world/src/osm/stadium.test.ts
subagents: explore × 1 (map how OSM lots become places)
do: Derive reserved tailgate zones from OSM parking areas near the stadium and emit places with
`kind: 'tailgate'` in the map bundle. Keep their cells walkable and reachable from a gate.
Do not change `contracts.ts`.
done-when: a unit test asserts the tailgate ids, that each has cells, that every cell is walkable,
and that at least four tailgate places exist within 1 km of the bowl. Existing stadium tests pass.
depends-on: ORD-001
result:

---

## Log

| id | title | status | verified by |
|---|---|---|---|
| ORD-001 | Windows install and baseline | verified | supervisor |
| ORD-002 | Ratio + synthetic banner | open | — |
| ORD-003 | Tailgate places | open | — |
