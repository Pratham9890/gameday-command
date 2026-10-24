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

- `engine/src/flowfield.ts` — multi-source BFS from a destination's own cells outward, frozen into a direction byte per cell so moving a dot is one array read. Fields are lazy and the whole cache is dropped when any closure changes, because a closure changes every route.
- `engine/src/movement-flow.ts` — the real crowd: arrivals off the fan type's window, walking the field, queueing against a gate's `throughputPerMin`, admission, seating. `densityFactor()` is the speed curve.
- `engine/src/sim.ts` — the step loop. Order inside one sim second matters: world hooks fire, **then** decisions resolve (the clock waits here), then officers move, then dots move, then density, then scoring. Changing that order changes results.
- `engine/src/sim.ts` → `buildAsks()` — turns raised situations into one `DecisionAsk` per `decisionKey`. This is what keeps model calls to a handful per step instead of thousands.
- `brain/src/client.ts` — the only thing that talks to the server about decisions. Every failure path (timeout, refused, bad JSON, odds that do not sum to 1) returns defaults with `source: 'default'`. Nothing here is allowed to throw.
- `world/src/scoring.ts` — a plain accumulator. Same samples in, same scorecard out, which is what makes replay-from-tape scoring match a live run.
- `server/src/fm.ts` — the commander briefing through Apple's on-device model via `fm serve` (a Chat Completions server; model `system`, always `stream: false`). The prompt measures **399 tokens** by `fm count-tokens` against a 4,000 budget. Keep it that small: an overflow comes back as a safety-looking error, not a length error.
- `server/src/briefing.ts` — `briefingIsSupported()` is the guard on the briefing: any number the model writes must already be on a scorecard (or in a name the request supplied). One invented figure throws the whole briefing away for the template.

## The OSM map

`world/data/ohio-stadium.osm.json` is a committed 2.5 MB Overpass extract (6,291 elements) around Ohio Stadium, OSM way 119153498. Refetch with `npm run fetch-map`.

**That script must run in a normal terminal, not through the Claude Code sandbox.** Overpass answers 406 to the sandbox's egress proxy — plain `curl`, Node `fetch` and every host tried behave the same, while the same URL works fine outside it. Use the Terminal panel.

`world/src/osm/stadium.ts` rasterizes the extract onto the 2 m grid. Open ground is the *default* and buildings and walls are subtracted, rather than the reverse: a game-day crowd walks across lawns and plazas OSM never tagged, so starting from `walk` models the real space far better than starting from `blocked`.

## Non-obvious decisions, and why

- **Imports use explicit relative `.ts` paths** (`../../contracts.ts`), not aliases. That one choice means `tsc`, Vite, Vitest *and* bare `node` all resolve the same imports with zero alias config, so `/server` runs with `node server/src/index.ts` and no build step.
- **No TypeScript parameter properties anywhere.** Node's type stripping rejects them, and `/server` imports `/brain` directly. Use explicit field declarations in classes.
- **One root `tsconfig.json`, DOM lib.** TypeScript errors if the `DOM` and `WebWorker` libs are both loaded, so `engine/src/worker.ts` types its own worker globals locally instead.
- **Vite is pinned once at the root** with `overrides: { "vite": "$vite" }`. Two Vite copies (one from vitest, one from the app) make `vite.config.ts` fail to typecheck with unassignable `Plugin` types.
- **better-sqlite3 is on 13.x.** 11.x cannot build against Node 26's V8 headers.
- **Sim time is relative to kickoff.** `SimSeconds` is negative before kickoff, so `startAt: -3600` is kickoff minus 60 minutes and an incident `at: 0` is kickoff.
- **Incident zones are expanded with `expandCells()`.** A gate surge zone is the crowd on the approach, not the one 2 m doorway cell — with a single cell almost no dots are ever inside it and no decisions fire.
- **Decision records are emitted one per dot.** The contract's `DecisionRecord` carries a single dot, and the dot detail panel must explain any dot the commander clicks. Measured: a lightning delay emits 57,974 records and the run still holds 103x real time, so this stays.
- **Dots wait off the map at (-1, -1) until their arrival time.** A fan still in their car is not crowd density and cannot be reached by a PA announcement. `DensityField` and `buildAsks()` both skip out-of-bounds dots, so this needs no special-case state.
- **A gate's field is built even when its door is shut.** Queued dots still need to know which way the gate is; `passable()` blocks admission and through-traffic instead. Closing a gate therefore makes fans pile up at it rather than teleporting away — which is the tradeoff the tool exists to show.
- **Never `push(...bigArray)`.** A stadium-sized parking place is ~190,000 cells and spreading that many arguments overflows the call stack. Found by the perf test, not the unit tests.
- **The speed curve is linear:** `v = v_free · max(0.05, 1 − ρ/5.4)`. One line, and it puts a visible crawl right at the 4 people/m² danger line.
- **`Math.fround` before deciding which cell a dot moves into.** Positions live in a `Float32Array` but moves are computed in float64. A position a hair past a cell boundary rounds *back* across it when stored, so the dot released a cell it was still standing in, the cell accepted another dot, and a 2 m square reported 13 people/m². Peak density is now exactly the physical cap. The invariant test in `flow.test.ts` guards this.
- **Occupancy is rebuilt from dot positions every movement pass**, not carried forward. Hand-maintained counts drift, and one stale decrement is invisible until a density number goes absurd. Rebuilding is O(dots) and makes any slip self-correct within one step.
- **A cell holds at most `MAX_DOTS_PER_CELL` (4 dots = 5 people/m²).** Slowing dots down is not enough on its own: at 5% speed they still creep into the cell ahead and end up stacked on one square. Refusing entry is what makes a queue back up along the approach, which every scorecard number depends on.
- **Dots sidestep.** A crowd on one flow field walks single file, and the first dot to stop blocks everyone behind it. Trying the two half-steps either side of the best direction is what lets a queue spread and flow around a jam.
- **Fans are admitted by proximity to a gate, not by standing on its cells** (`admitAtGates`). A turnstile serves the queue in front of it; which 2 m square a fan stands on must not decide whether the gate works. Requiring presence on specific cells deadlocked every gate — those cells filled with fans walking past to the next gate and fans already admitted walking inward, so gates sat idle with thousands queued and their entire throughput unspent.
- **Gate flow fields refuse to route through the bowl** (`field(place, avoidInterior)`). The deck and concourse are walkable, so a plain field routed a fan in the north lot to an east gate straight through the Horseshoe and out the far side.
- **Each gate carries an assignment quota** (`GATE_QUOTA_SLACK`). Nearest-gate-by-seat alone let the horseshoe's geometry hand one gate 4,195 fans while others idled.
- **A gate is a wide arc on the *outside* of its corridor.** A 3-cell gate in the middle of the corridor got permanently plugged by fans walking past to the next gate and by fans already admitted walking inward, so nobody who wanted *that* gate could reach the turnstile and gates sat idle with thousands queued.
- **Gate throughput is a rate, not a bank** (`GATE_BURST_S`). Uncapped, a gate that stood idle for an hour waved 2,600 fans through the instant a queue reached it.
- **Your gate is the one by your seat**, as a ticket assigns it — not the one nearest your car. Picking by car funnelled the whole crowd through the two or three gates facing the big lots.
- **Everyone is assigned a seat before they arrive**, and walks to it in a straight line once inside the bowl. Without it they stopped at whichever stands cell sat just inside their gate. Settling early is also wrong: fans sat down in the gate mouth and corked the gate behind them.
- **`safeCountFor()` sets "clear" at 2 people/m², not zero.** A zone never empties while fans are still arriving, so `safeCount: 0` read as "never cleared" for every plan alike and the scorecard could not tell them apart.

## App screens

`app/src/App.tsx` holds the whole commander view: incident panel, playbook with a per-step plan editor, three runs side by side, scorecards, replay scrubber, briefing, and dot detail. Two things worth knowing:

- `useRun` keeps frames and decision records in **refs**, not state. A frame carries five typed arrays and a lightning delay emits ~58,000 decision records in one step; re-rendering the tree per record would cost far more than drawing it. Counters are surfaced on the next frame instead.
- `useRun` is called three times unconditionally in `App`, one per comparison slot, so the scorecards live in one place and the briefing can be built from all three.

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

Milestone 3 in progress: the real Ohio Stadium map from OpenStreetMap loads and all three plans run on it at kickoff minus 60. See the open items at the end.

Milestone 2: the real engine runs. Flow fields, density-limited walking speed, gate queues against real throughput, and closures that reroute the crowd. `movement-circle.ts` is kept only as the reference `MovementModel` stub.

Measured on an 800x800 map (stadium plus half a mile at 2 m cells), 20,000 dots / 100,000 fans, in process:

| | |
| --- | --- |
| movement, no decisions | 140x real time |
| lightning delay asking every dot | 107x real time |
| decision grouping | 57,974 dot decisions to 121 distinct keys |

On the real stadium map (800x800 cells, 100,000 fans as 20,000 dots), three plans run at about 300x real time with peak density at exactly the physical cap.

**Open items, in order:**
1. **Entry throughput.** Gate load is now even (roughly 750-1,900 fans per gate, was 160-4,195) and admissions roughly doubled, but gates still run at about 14% of their rated throughput: around 5,000 of 20,000 dots are inside by kickoff plus 15, with the rest queued on the approach. Ruled out as causes: OSM barriers (no measurable difference), gate geometry, and banked throughput. The remaining suspect is approach width around the bowl once routes through the interior are correctly forbidden. Measure where non-admitted dots sit relative to their gate before changing anything else.
2. Live Kev decisions end to end (the client, server, cache, tape and fallback all work and are tested; it has not yet been run against a live Kev on :8009).
3. `pick_gate` is assigned by seat rather than asked of Kev; it should become a live decision.
4. The app has not been seen rendering in a browser. It builds, mounts with no console errors, and `vite build` emits the worker chunk, but the in-app browser pane refuses to display and Playwright cannot reach DOMContentLoaded.
