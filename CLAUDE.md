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
- `server/src/index.ts` → `POST /api/decide` — cache, then Kev, then defaults, **biggest groups first under one shared deadline**. A cold lightning delay raises ~135 keys at once and a single GPU answers them one at a time, so they cannot all fit inside the engine's 2 s pause. Asking for everything in parallel timed out into defaults for nearly all of it (2,203 model-backed dot decisions); asking the biggest groups first gets 16,381 with the same 1.7 s pause. The long tail of small groups takes the default on purpose.
- `brain/src/client.ts` — the only thing that talks to the server about decisions. Every failure path (timeout, refused, bad JSON, odds that do not sum to 1) returns defaults with `source: 'default'`. Nothing here is allowed to throw.
- `world/src/scoring.ts` — a plain accumulator. Same samples in, same scorecard out, which is what makes replay-from-tape scoring match a live run.
- `server/src/kev.ts` — **Kev is not a chat model.** It exposes a TypeSafe-compatible `POST /v1/systemone`: a state plus typed questions in, one prefill pass, typed answers out, and no text generation at all. A `choice` question comes back with `probabilities` keyed by the option names we sent, which is exactly the contract's `Odds` — nothing to parse out of prose. The first version of this client posted OpenAI chat completions and scraped JSON from the reply; against the real server that would have 404'd and turned every decision into a fallback. `GET /v1/models` lists the model names it accepts (`kev-latest` by default).
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
- **Your gate is the one you can walk to from where you parked**, measured along the flow field, with a per-gate quota so no gate takes a third of the stadium. Assigning by seat looked more like real ticketing, but with interior routes rightly forbidden it sent half the crowd on a hike around the bowl, where they jammed in the narrow gaps between the stadium and the buildings around it — the far gates never saw a single fan all game.
- **A blocked dot may take a short detour** (`DETOUR_SLACK`). The first pass only moves closer to the gate, which is what a queue does; the second runs only when every way forward is full. Without it the crowd deadlocks outright — a dot may only enter a cell at least as close as its own, so once a corridor fills nothing behind it ever moves again.
- **Admission reach is measured along the flow field**, not as a box around the gate's centre. A gate is a block of cells, so a fan ten steps from its edge can be thirteen from its middle, and the box quietly refused to serve the very front of the queue.
- **A fan whose gate is unreachable is reassigned** to one they can reach, rather than standing still for the rest of the game.
- **An officer arriving at their post raises `officer_instruction` for the people around them, once**, and fans who choose to follow head for where that officer was posted. Before this, sending officers only moved a number on the scorecard — they walked to their post and stood there, invisible to every fan — so two of the three lightning plans scored identically, the only thing separating them being officers. The contract already carried the situation and its options; nothing was listening. Plan B for a lightning delay posts its officers on the *gates* for the same reason: on the concourse they were talking to people already under cover.
- **Everyone is assigned a seat before they arrive**, and walks to it in a straight line once inside the bowl. Without it they stopped at whichever stands cell sat just inside their gate. Settling early is also wrong: fans sat down in the gate mouth and corked the gate behind them.
- **`safeCountFor()` sets "clear" at 0.2 people/m²**, one person per five square meters. Both ends of this get it wrong: `safeCount: 0` never clears because fans keep arriving, while 2/m² was so generous the north gate zone counted as clear at its worst moment (855 people against a threshold of 2,432). Either way every plan scored alike.
- **Clearance is only counted from the incident onward.** The zone is busy long before kickoff, so scoring the whole run let it "clear" during the build-up; the negative time clamped to zero and all three plans read 0.0 minutes.

## Verifying the app in a browser

`app/bench.html` + `app/src/bench.ts` measure requirement 3 where it has to hold: 20,000 dots in **one real browser Web Worker** with a warm cache. It deliberately contains no PixiJS (see below). It also asks the worker for a `snapshot` part way in and checks its shape, so the contract's restart point is exercised through the worker rather than only through the engine module under Node.

It also drives a `seek`, which is the contract's restore path across the worker boundary: the worker rewinds to the nearest checkpoint and steps forward, and the frame must come back at the moment asked for, not merely somewhere earlier.

Measured in headless Chrome against a cache warmed by the real Kev: **222.5x real time**, 20,000 dots, **121 decisions all from cache and zero fallbacks**, snapshot ok with a 4-word RNG state and 20,000 dots, and a seek asked for t=-2250 answering at exactly t=-2250.

Drive a headless browser with Chrome's own DevTools Protocol — Node has a built-in `WebSocket`, so this needs no dependencies:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --use-angle=swiftshader --enable-unsafe-swiftshader --remote-debugging-port=9222 \
  --user-data-dir=/tmp/gd-chrome about:blank
```

**No `<StrictMode>` in `main.tsx`, deliberately.** StrictMode mounts every effect twice in development. PixiJS owns a WebGL context imperatively, and tearing the throwaway first `Application` down while the real second one is still initialising leaves the second `init()` unresolved: the page stops mid-setup, draws nothing, and reports no error. The production build was always fine, which made it easy to misread as the browser's fault. Found with `document.title` beacons — execution stopped at the `if (disposed)` branch — after `Debugger.pause` showed the main thread wedged. Waiting for the init promise before destroying is not enough; do not reintroduce StrictMode without re-checking `npm run dev` in a browser.

**PixiJS also cannot start under software GL**, with one context or three. `Application.init` calls Pixi's own `checkMaxIfStatementsInShader`, which compiles shaders in a loop to find the GPU's `if` limit. On real hardware that is instant; under SwiftShader (and so in any headless browser here, including with `--use-angle=metal`, which falls back) it never finishes, and it pegs the renderer hard enough that Chrome stops answering DevTools requests. A stack dump via `Debugger.pause` shows exactly that frame. The app's DOM renders fine before it — a probe at 2.5 s finds every panel, all three plan names, the editor steps and the scrubber, with zero page errors — so the map canvas is the only part that cannot be checked this way.

## Rewinding a run

`Simulation.checkpoint()` / `rewind()` are the restart points, and the worker keeps one every `CHECKPOINT_EVERY_S` so `seek` can rewind to the nearest and step forward.

A checkpoint is **not** just the contract's `Snapshot`. `Snapshot` is frozen and carries only what crosses the lane boundary, so it says nothing about arrival times, assigned seats and gates, who has already been admitted, or the gates' throughput budgets — nor about what the scorer has accumulated. A rewind that restored only `Snapshot` would drift: fans would forget which gate they were sent to, and officer minutes would be counted twice. So `MovementModel` has optional `capture()` / `restore()`, the `Scorer` has the same, and `Checkpoint` bundles all three. Two tests hold this down: a rewound run reproduces the crowd and the scorecard exactly, and a rewind does not inflate the accumulating totals.

The app's replay scrubber draws kept frames while you drag, because that is instant. **Rewind runs to here** then sends `seek` to all three workers, so the simulations themselves go back and play resumes from that moment — measured in a browser: three workers at t=-3000 went to t=-3330 together, with the frames after it dropped.

## App screens

`app/src/App.tsx` holds the whole commander view: incident panel, playbook with a per-step plan editor, three runs side by side, scorecards, replay scrubber, briefing, and dot detail. Two things worth knowing:

- `useRun` keeps frames and decision records in **refs**, not state. A frame carries five typed arrays and a lightning delay emits ~58,000 decision records in one step; re-rendering the tree per record would cost far more than drawing it. Counters are surfaced on the next frame instead.
- `useRun` is called three times unconditionally in `App`, one per comparison slot, so the scorecards live in one place and the briefing can be built from all three.
- **All three runs draw into ONE PixiJS Application** (`ComparisonMaps.tsx`), as three panels of a single canvas with the base map texture shared between them. Three Applications meant three WebGL contexts and paying Pixi's GPU probe three times over. Dots are pixel bytes, the heatmap reuses one `ImageData`, the incident zone is drawn only when it changes, and the renderer is stopped and driven by hand — frames arrive every 15 sim seconds, so a running ticker redraws an unchanged scene sixty times a second.

## The close-up view

`app/src/CrowdView.tsx` + `app/src/crowd-scene.ts` are the default map: one run on an isometric map you can zoom into until dots become people, click one, and change them. The look follows the operator view in Cryplo/MHacks26. The A/B/C chips pick the run; **Side by side** brings back `ComparisonMaps`.

- **Only one of the two map views is mounted at a time**, so the page still holds one WebGL context. `ComparisonMaps` now redraws when its Application comes up, or switching back while paused showed a blank canvas.
- **Level of detail keeps 20,000 dots cheap.** Zoomed out, the crowd is one 800x800 cell texture, the same trick as the side-by-side maps. Past `PEOPLE_MIN_SCALE` only groups inside the viewport get a pooled figure (five sprites from five shared white textures, tinted), capped at `MAX_PEOPLE`. Cost follows the screen, not the crowd.
- **Unlike `ComparisonMaps`, this one runs Pixi's ticker.** People tween between the last two frames over the measured gap between arrivals, so they walk instead of hopping every 15 sim seconds. A replayed frame is drawn exactly, with no tween.
- **Buildings are extruded polygons**, one roof per run of at most 6 blocked cells and a wall on every south or east face (the two this viewpoint sees), sorted by x + y. Height and roof colour come from the connected building; pieces under 40 cells are walls and fences and stay 2.5 m. Runs are short because a long run sorted by one key paints over buildings in front of it. People always draw over buildings.
- **Shirt colour is the fan type, ring colour is the state.** Names come from `groupName(dot)`, so the person you clicked is someone you can find again.
- **Pixi does start under SwiftShader in this Linux container** (Playwright's Chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader`), unlike headless Chrome on the Mac. That is how the close-up was checked: canvas up in 2.4 s, zoom, click, edit, zero page errors.

### Editing fans

The inspector sends an edit (`fanType`, `sendTo`, for one group or everyone within 10 or 25 m) to **all three workers for the same sim second**, two frames ahead of the furthest plan, so the runs still differ only by their plans. The extra worker messages (`edit`, `inspect`, `types`) live in `engine/src/edits.ts`, **not** in the frozen `contracts.ts`: only the app and the engine's own worker speak them.

- `Simulation` keeps every edit for the life of the run and applies it when the clock reaches its second. A rewind to before an edit replays it; `seek` drops edits after the target, like the frames after it. `edits.test.ts` holds both down.
- `seek` now also drops checkpoints after the restart point. They were taken on a timeline an edit can rewrite, and a later seek would have restored one that lies.
- `FlowMovement.sendTo` will not walk an un-admitted fan straight into the bowl: "their seat" or the concourse sends them to their gate first. A new gate resets `admitted`; heading for the car marks them through, because on the way out a gate is a door.
- Fan types ride to the app in a `types` message only when they change (spawn, edit, rewind), never per frame.

## Running the real Kev

Kev is cloned at `/Users/nipun/Projects/kev` (Apache-2.0). Start it with the command from `GOAL.md`:

```bash
cd /Users/nipun/Projects/kev && uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009
```

First run downloads the `jaredpalmer/kev-4b` LoRA (160 MB) and `Qwen/Qwen3.5-4B-Base` (9.3 GB) into `~/.cache/huggingface`; after that it starts in seconds. `GET /v1/models` reports what it loaded — on this Mac: *Kev pointer head on Qwen/Qwen3.5-4B-Base, serving jaredpalmer/kev-4b at temperature 2.41*, backend `mlx`, device `mps`, bfloat16.

The first request pays MLX warm-up and will exceed the timeout; it falls back once and every request after is warm (~250 ms).

## The cache ships warm

`server/data/decision-seed.json` holds 544 answers the real Kev-4B already gave (84 KB). `openDb()` loads them into an empty `decision_cache`, so a fresh clone is model-driven from the first click rather than guessing its way through the first run of every scenario. Measured on a brand-new database: a lightning delay runs **54,253 decisions, all from the model, zero fallbacks**, with the pause down to 0.4 s.

Regenerate after changing fan types, situations or the `decisionKey` context — those change the keys and the old ones stop matching:

```bash
npm run warm                      # against a live Kev
DB_PATH=./data/gameday.db npm run seed:export
```

## Warming a cache yourself

```bash
npm run serve     # with Kev on :8009
npm run warm      # runs all three incidents x three plans, then waits for the warmer
```

Only needed if you have changed the decision vocabulary; otherwise the shipped seed covers it.

Takes a few minutes and settles around 538 keys on the stadium map. After it, every fan decision in the demo comes from the model: the last run measured **zero fallbacks on all three plans**. Skip it and the first run of each scenario is mostly defaults, which is correct behaviour but not a good look on stage. The cache lives in SQLite at `DB_PATH`, so it survives restarts.

`?autorun=1` starts the three runs without a click, and the app saves each finished comparison through `POST /api/comparisons` — which is how a run in an ordinary browser window can be checked from the server side, with no debugger attached.

## Live model tests

`server/src/live.test.ts` talks to the real Kev on :8009 and the real `fm serve` on :8080. Each block **skips itself when the service is not listening**, so `npm test` passes on a bare checkout; when the models are up they run as part of the suite. They are the guard against the mistake made earlier in this project — building a stand-in from the same wrong assumption as the client, so both agree and neither matches the real server.

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

Everything in `GOAL.md` is built and running. The repo is five npm workspaces around the frozen `contracts.ts`, 110 tests and `tsc` pass, and the demo runs end to end on the real Ohio Stadium map with the real models.

Measured on the stadium map (800x800 cells at 2 m, 100,000 fans as 20,000 dots):

| | |
| --- | --- |
| one browser Web Worker, warm cache | **222x** real time, zero fallbacks |
| three plans at once in the app | **56.8x** real time each |
| lightning delay, ice-cold cache | **43.2 s** wall (the bar is 60 s) |
| decision grouping | 57,974 dot decisions to ~144 model calls |
| peak density | exactly 5.00 people/m², the physical cap |

Last demo run, plain Chrome with no debugger attached, cache warmed: plan A clears the north gate in 6.2 min, plan B in 8.6, plan C never — and **zero fallbacks on all three**.

**Open items, in order:**

1. **A cold cache is mostly fallbacks until it warms.** The model answers in ~250 ms, so of the ~144 keys a lightning delay raises at once only a handful land inside the engine's 2 s pause; the rest take the defaults and are counted as fallbacks, which is what the contract asks for. `makeWarmer` then fetches them in the background without a deadline, so the cache completes by itself (144 of 144 keys about 80 seconds later) and the same scenario then runs with zero fallbacks. Run `npm run warm` before a demo. Raising `KEV_CONCURRENCY` makes the cold case *worse* (16 answered one key where 4 answered five) because Kev serialises on one GPU — leave it at 4.
2. **Safari: the likely cause was fixed, and the fix is unverified on Safari itself.** Safari loaded the app and its workers really did call `/decide`, but ninety sim minutes had not completed after six wall minutes. The worker used to sleep once per *sim second* (`1000 / speed` ms), and Safari clamps `setTimeout` to about a second in a tab whose app is not frontmost, workers included — so at the app's default speed of 20 every 50 ms sleep became 1,000 ms and the run paced itself at real time, needing the full 90 minutes. The arithmetic matches the symptom exactly. `loop()` now makes up every step the wall clock owes before sleeping at all, so a coarse timer costs fewer, bigger batches instead of a slower run.

   What is proven: the change is not a regression, and is a gain — the headless Chrome bench went 222.5x → **254.4x**, snapshot and seek still exact, 105 tests pass. What is **not** proven: that Safari now finishes. The run was started under the right conditions (demo tab selected, Safari not frontmost) and killed at 160 s, which proves nothing either way — at speed 20 a 90 minute scenario cannot finish in under ~270 s however fast the engine is, so the test needs about 6 minutes of patience. **Re-run it before claiming Safari works.** Demo in Chrome meanwhile.

   Note the speed cap when testing: wall time for a full run has a floor of `5400 / speed` seconds. Six minutes at speed 20 is barely past that floor, which is part of why the original failure looked ambiguous.
3. **`pick_gate` is assigned by walking distance rather than asked of Kev.** It should become a live decision; it is the one situation in the contract the engine still decides by itself.
4. **The in-app browser pane will not display**, so the map canvas cannot be checked from inside Claude Code. Real Chrome is fine — drive it over the DevTools Protocol as described above. This is the environment, not the app.
5. **The perf assertions are load-sensitive.** They pass with roughly a 5x margin (47-50x measured against a bar of 10x) while Chrome and Kev are both busy, but a much heavier machine could close that. A `npm test` failure here is worth re-running before believing.
