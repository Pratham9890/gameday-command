# Gameday Command — notes for the next session

Read `GOAL.md` for what this is and `contracts.ts` for the shared contract. **`contracts.ts` is frozen** — ask Nipun before changing it, then bump `CONTRACT_VERSION`.

## Layout

| Path | Owns |
| --- | --- |
| `contracts.ts` | The only cross-lane vocabulary. Frozen. |
| `engine/` | Sim loop, seeded RNG, typed-array dots, density grid, Web Worker entry. No AI. |
| `world/` | Maps, incidents, playbook plans, officers, scoring. Changes the world only through `WorldActions`. |
| `brain/` | Fan types, situations, decision defaults, decision client, odds sampling, tape. |
| `server/` | Hono + better-sqlite3. Decision cache, plans, comparisons, Kev and briefing clients. |
| `app/` | Vite + React + PixiJS 8. Three runs side by side. |

## Where the key logic lives

- `engine/src/sim.ts` — the step loop. Order inside one sim second matters: world hooks fire, **then** decisions resolve (the clock waits here), then officers move, then dots move, then density, then scoring. Changing that order changes results.
- `engine/src/sim.ts` → `buildAsks()` — turns raised situations into one `DecisionAsk` per `decisionKey`. This is what keeps model calls to a handful per step instead of thousands.
- `brain/src/client.ts` — the only thing that talks to the server about decisions. Every failure path (timeout, refused, bad JSON, odds that do not sum to 1) returns defaults with `source: 'default'`. Nothing here is allowed to throw.
- `world/src/scoring.ts` — a plain accumulator. Same samples in, same scorecard out, which is what makes replay-from-tape scoring match a live run.
- `server/src/briefing.ts` — `briefingIsSupported()` is the guard on the briefing: any number the model writes must already be on a scorecard (or in a name the request supplied). One invented figure throws the whole briefing away for the template.

## Non-obvious decisions, and why

- **Imports use explicit relative `.ts` paths** (`../../contracts.ts`), not aliases. That one choice means `tsc`, Vite, Vitest *and* bare `node` all resolve the same imports with zero alias config, so `/server` runs with `node server/src/index.ts` and no build step.
- **No TypeScript parameter properties anywhere.** Node's type stripping rejects them, and `/server` imports `/brain` directly. Use explicit field declarations in classes.
- **One root `tsconfig.json`, DOM lib.** TypeScript errors if the `DOM` and `WebWorker` libs are both loaded, so `engine/src/worker.ts` types its own worker globals locally instead.
- **Vite is pinned once at the root** with `overrides: { "vite": "$vite" }`. Two Vite copies (one from vitest, one from the app) make `vite.config.ts` fail to typecheck with unassignable `Plugin` types.
- **better-sqlite3 is on 13.x.** 11.x cannot build against Node 26's V8 headers.
- **Sim time is relative to kickoff.** `SimSeconds` is negative before kickoff, so `startAt: -3600` is kickoff minus 60 minutes and an incident `at: 0` is kickoff.
- **Incident zones are expanded with `expandCells()`.** A gate surge zone is the crowd on the approach, not the one 2 m doorway cell — with a single cell almost no dots are ever inside it and no decisions fire.
- **Decision records are emitted one per dot.** The contract's `DecisionRecord` carries a single dot, and the dot detail panel must explain any dot the commander clicks. Revisit if the 20,000-dot perf target shows it costing real time.

## Commands

```bash
npm run typecheck     # tsc over every lane, one pass
npm test              # vitest
npm run serve         # API on 8787
npm run dev           # app on 5173, proxies /api to 8787
```

Kev (optional — without it every decision is a fallback, by design):

```bash
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009
```

## Current state

Milestone 1: every lane has a real, tested stub. Movement is `engine/src/movement-circle.ts`, a stand-in that orbits dots around their spawn point; it implements `MovementModel`, so the real flow-field engine drops in without touching the sim loop, the worker, or the app. Next: flow fields and density-limited speed on the test map.
