# CONTEXT — Gameday Command v3

Read this first. Companions: `TODO.md` (ordered work), `ORDERS.md` (how the Claude on this PC
directs the active chat session), `CLAUDE.md` (upstream engineering notes — still authoritative
for the engine and the traps).

Last updated: 2026-10-24, at the start of `feat/command-v3`.

---

## 1. What the product is

A practice tool for police commanders who run game day at Ohio Stadium. It simulates the crowd
and traffic around the stadium, lets a commander trigger an incident, runs up to three response
plans on the same crowd and seed, and scores each one. The commander makes the call; the tool
shows tradeoffs.

The v3 goal: **show the crowd now, forecast where it moves next, let the commander commit an
intervention, and re-forecast from the new state.**

---

## 2. Repo state

| | |
|---|---|
| Remote | `https://github.com/SNBest1/gameday-command.git` (write access verified) |
| Base | `main` @ `1d48d31` — merge of both teammate PRs (vehicles + weather, walled gates + police) |
| Working branch | `feat/command-v3`, cut from `1d48d31` — the only branch we commit to |
| Backup | `backup/isometric-ui` — our abandoned Three.js app, pushed for history only |
| Old local repo | retired; only the backup branch remains there |

**Do not port the old app.** Its renderer, HUD, and UI were deliberately dropped. What we carry
over is the prediction layer (section 5).

### What their `main` added since the engine we vendored (`2f50690` → `1d48d31`)

- Vehicle traffic at real scale: 4,500 vehicles, parking stalls, lane changes, yielding to crowds,
  an ambulance per incident (`engine/src/traffic.ts`, `world/src/vehicles.ts`).
- Weather timelines: clear, rain, thunderstorm, snow, fog, heat; slows walkers and drivers
  (`world/src/weather.ts`, `app/src/WeatherFx.tsx`).
- Enforced gates: nobody enters the bowl unscreened; shut gates turn their queue away.
- The 3D Horseshoe: tiered stands, field, crowd seated on tiers (`app/src/stadium3d.ts`).
- Police hotspots and traffic-flow colouring (`app/src/congestion.ts`).
- Gates panel, officer panel, live step status, story/verdict copy.

---

## 3. Why we pivoted

Our old app had 45 modules and 9,579 lines; **22 modules were never imported by the running app**.
It had a good map and no product loop. Their app is a complete product with a real engine, real
plans, scoring, replay, a server, and tests.

We keep their app. We add the one thing it explicitly refuses to do: a forecast.

Their `README.md:5` and `App.tsx:1203` say "an assumption, not a forecast". That was an honest
choice for their scope. It is also the gap the v3 brief fills.

---

## 4. Environment on this PC

Windows 11, PowerShell. Use the portable toolkit; never install system-wide.

```powershell
. "$env:USERPROFILE\.config\openchamber\toolkit\activate.ps1"
```

| | |
|---|---|
| Node | 24.22.1 (toolkit) |
| `npm install` | **currently fails** — `better-sqlite3@13.0.3` has no prebuilt for Node 24, falls back to `node-gyp`, no Visual Studio C++ toolchain. First task is replacing it with built-in `node:sqlite`. |
| Kev | not available (macOS/MLX). The app must run on defaults and label fallbacks. |
| `fm serve` | not available (macOS). Briefing falls back to the template. |
| Ports | app `5173`, API `8787` (their defaults). Kill stale dev servers before starting. |

Commands once the install is fixed:

```powershell
npm install
npm run typecheck
npm test
npm run serve     # Hono API on 8787
npm run dev       # app on 5173, proxies /api
```

---

## 5. What "our engine" means now

Our engine **is** their engine from eight commits ago. Porting the simulation core would be a
downgrade. The prediction layer is the contribution:

| Old module | What it does | Target in this repo |
|---|---|---|
| `provider.ts` | cache → Kev → heuristic logit; monotone, officer override; 17 tests | `brain/src/client.ts` fallback path |
| `ensemble.ts` | variants, likelihood, reweight, resample, combine | new `engine/src/forecast.ts` |
| `observe.ts` | synthetic sensors: noise, latency, dropout, coverage | new `app/src/sensors.ts` |
| `actions.ts` | 6 intervention kinds, 28 real-campus locations | `app/src/interventions.ts` |
| `score.ts` | peak avoided per officer-minute | `world/src/scoring.ts` comparison |
| `dayScript.ts` | 05:00–21:00 phases, kickoff clock | `app/src/dayclock.ts` |

Old paths are under `backup/isometric-ui:src/sim/`. Read them for the algorithms; rewrite them
against this repo's types and worker boundary. Nothing imports the old types.

---

## 6. Gaps this branch exists to close

| # | Gap | Where it shows | Fix |
|---|---|---|---|
| 1 | No forecast, only forward replay | `README.md:5`, `App.tsx:1203` | ensemble forecast from a snapshot |
| 2 | No uncertainty / calibration | — | p10/p50/p90 bands + coverage test |
| 3 | No observation feed | no sensors anywhere | synthetic sensor layer, reweight |
| 4 | No receding horizon | "Restart with my changes" replays from the start | commit → re-forecast from now |
| 5 | Officers get no orders in-app | `OfficerPanel.tsx` is read-only | roll-call panel + dispatch + ack |
| 6 | Pedestrianize missing | contract action union | engine-private edit in `edits.ts` |
| 7 | Lane control missing | gates have throughput only | gate throughput edit |
| 8 | Lot diversion not first-class | `redirect` exists, no lot UI | lot → lot presets |
| 9 | Alert channels only PA/phone | contract action union | channel presets; true extra channels need v3 |
| 10 | Tailgates are not places | no `tailgate` in `world/src/osm/stadium.ts` | derive reserved zones from OSM lots |
| 11 | 1 dot = 5 fans is not on screen | code comment only | HUD + legend line |
| 12 | Windows install broken | verified `npm install` failure | `node:sqlite` |
| 13 | Kev is macOS/MLX-only, fixed concurrency | `server/src/kev.ts` | endpoint-agnostic URL, adaptive concurrency |
| 14 | Danger deltas 1–4 %; lightning/package never clear | `CLAUDE.md:148–158` | near-incident + spillover scoring |
| 15 | `pick_gate` decided by the engine | `CLAUDE.md:265` | raise it as a Kev decision |
| 16 | Cold cache is mostly defaults | `CLAUDE.md:259` | port the heuristic logit |
| 17 | Safari unverified | `CLAUDE.md:260` | verify or document |

---

## 7. Architecture map

Five npm workspaces around a frozen contract:

```
contracts.ts        frozen, gameday.v2 — types + decisionKey() + constants
engine/             sim loop, flow fields, traffic, weather, worker; no AI in movement
world/              OSM map raster, incidents, playbook plans, officers, scoring
brain/              fan types, situations, decision defaults, decision client, tape
server/             Hono + sqlite; decision cache, plans, comparisons, Kev, briefing
app/                Vite + React + PixiJS 8; three views
```

Key files for the work:

| File | Why it matters |
|---|---|
| `engine/src/sim.ts` | step order: hooks → decisions (clock waits) → officers → dots → density → scoring |
| `engine/src/edits.ts` | **not in the contract** — the private worker messages (edit, inspect, types, scene). New forecast/pedestrianize messages belong here. |
| `engine/src/worker.ts` | worker entry; snapshot, seek, checkpoint messages |
| `engine/src/flowfield.ts` | weighted search; `stepCost(kind)` |
| `app/src/useRun.ts` | one run per plan; frames/decisions in refs, not state |
| `app/src/CrowdView.tsx` | default 3D close-up; one WebGL context |
| `app/src/crowd-scene.ts` | layered people, LOD, `PEOPLE_MIN_SCALE`, frame tweening |
| `app/src/ComparisonMaps.tsx` | side-by-side 2D; one Pixi app, three panels |
| `app/src/App.tsx` | commander screen: situation → three plans → verdict |
| `world/src/playbook.ts` | preset plans per incident |
| `world/src/scoring.ts` | scorecard accumulator |
| `server/src/db.ts` | `better-sqlite3` — replace with `node:sqlite` first |
| `server/src/index.ts` | `POST /decide` cache → Kev → defaults, biggest groups first |

---

## 8. Constraints

- **`contracts.ts` is frozen.** Do not change it. If pedestrianize or extra alert channels truly
  need new fields, stop and ask Nipun to bump `CONTRACT_VERSION` to v3.
- **No paid APIs.** Kev and the briefing run locally; when absent, the app still runs.
- **No UI rewrite.** Their PixiJS 2D + 3D close-up is the UI. Add panels; do not replace screens.
- **No vector OSM port.** Their 3D Horseshoe and raster map are further along. Our campus data
  stays in the backup branch.
- **Synthetic data is labelled on screen.** A zone with no sensor must look different from a
  measured one. A forecast is a model output, never "observed".
- **Numbers come from the model.** A constant typed next to a label is a bug.
- **Sim time is relative to kickoff.** `-3600` is kickoff minus 60 minutes; `0` is kickoff.
- **1 dot = 5 fans.** 20,000 dots stand for 100,000 fans.

---

## 9. Plan of record

1. **Phase 0** — repo surgery, Windows baseline (`node:sqlite`), tests green.
2. **Phase 1** — honesty and small gaps: ratio, synthetic banner, tailgate places, officer roster,
   day scrubber, zone/lot boards.
3. **Phase 2** — six interventions as presets over the frozen contract, plus officer orders/ack.
4. **Phase 3** — forecast ensemble, synthetic observations, reweighting, commit → re-forecast.
5. **Phase 4** — danger scoring, `pick_gate`, research note, docs.

Details and acceptance tests: `TODO.md`.

---

## 10. Traps already paid for

From `CLAUDE.md` (read the whole section before touching the renderer):

- **No `<StrictMode>`.** It double-mounts and wedges Pixi's `init()`; the page stops with no error.
- **Pixi cannot start under software GL** in some headless setups. DOM still renders; the map
  canvas is the part you cannot check that way.
- **HMR can wedge a 2D view.** A fresh tab runs fine; reload rather than trust a page after many
  HMR updates.
- **Never `push(...bigArray)`** — a parking place is ~190,000 cells and overflows the stack.
- **`Math.fround` before choosing a cell** — float64 moves stored as float32 can round back across
  a boundary and double-count density.
- **Step order in `sim.ts` matters.** Changing it changes every scorecard.
- **Rebuild occupancy from dot positions** every movement pass; never carry counts forward.

From our old repo:

- Engine start time: the first frame has every dot off-map at `(-1,-1)`; prime with steps.
- Vite in this environment only hot-reloads `App.tsx` reliably; restart after editing anything else.

---

## 11. How this chat is directed

The Claude on this PC reads this file and `TODO.md`, then writes orders into `ORDERS.md`.
The active chat session reads `ORDERS.md`, executes open orders in order, and appends results.
See `ORDERS.md` for the exact format and rules.
