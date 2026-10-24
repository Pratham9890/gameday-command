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
do: what to change, in two or three sentences.
done-when: the check that proves it.
depends-on: ORD-000 (optional)
result:
```

---

## ORD-001 — Make the repo install and test on Windows

priority: high
status: open
files: server/src/db.ts, package.json, server/src/index.ts, server/src/db.test.ts
do: Replace `better-sqlite3` with the built-in `node:sqlite` (`DatabaseSync`). Keep the schema,
the `user_version` cache reset and `seedDecisions()` behaviour identical. Remove
`better-sqlite3` from `package.json` and from `allowScripts`. Make the `decision-seed.json` path
resolve with either separator on Windows. Do not change `contracts.ts`. Do not touch the app.
done-when: from a clean `node_modules`, `npm install` completes with no Visual Studio and no
node-gyp; `npm run typecheck` is silent; `npm test` is green. Report the exact test-file and
test-case counts, and any live-model tests that skipped.
result:

---

## ORD-002 — Put the ratio and the synthetic-data warning on screen

priority: normal
status: open
files: app/src/App.tsx, app/src/styles.css (plus a small component if needed)
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
| ORD-001 | Windows install and baseline | open | — |
| ORD-002 | Ratio + synthetic banner | open | — |
| ORD-003 | Tailgate places | open | — |
