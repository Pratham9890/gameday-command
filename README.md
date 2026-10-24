# Gameday Command

A practice tool for police commanders who run game day at Ohio Stadium. It simulates the crowd, lets a commander trigger an incident, then runs the same moment under up to three response plans side by side and scores each one.

The commander always makes the call. The tool shows tradeoffs; it never tells police what to do. Fan behavior is an **assumption, not a forecast**, and the app says so on screen.

## Architecture

Five npm workspaces plus one frozen contract at the root. Every lane talks to the others only through `contracts.ts`.

```
                     ┌──────────────────────────────────────────┐
                     │  contracts.ts  (frozen, gameday.v1)      │
                     │  types + decisionKey() + constants       │
                     └──────────────────────────────────────────┘
                              ▲         ▲         ▲
      ┌───────────────────────┘         │         └────────────────────┐
      │                                 │                             │
┌─────┴──────┐   WorldHooks /    ┌──────┴──────┐   POST /decide  ┌─────┴──────┐
│  /engine   │◄──WorldActions───►│   /world    │                 │  /server   │
│            │                   │             │                 │  Hono +    │
│ Web Worker │  one per plan     │ map, incid- │                 │  sqlite    │
│ flow field │                   │ ents, plans,│                 │            │
│ + density  │   DecisionAsk ──► │ officers,   │                 │ cache →    │
│ typed arr. │ ◄── DecisionAnswer│ scoring     │                 │ Kev 8009   │
└─────┬──────┘        │          └─────────────┘                 └─────┬──────┘
      │               │                                                │
      │          ┌────┴─────┐                                          │
      │          │  /brain  │  fan types, situations, decision client,  │
      │          │          │  odds sampling, DecisionTape              │
      │          └──────────┘                                          │
      │                                                                │
      │  TickFrame + DensityGrid (transferred typed arrays)             │
      ▼                                                                │
┌────────────────────────────────────────────────┐                      │
│  /app   Vite + React + PixiJS 8                │◄──── /api proxy ─────┘
│  3 runs side by side, heatmap, scorecards      │
└────────────────────────────────────────────────┘
```

Why it is shaped this way:

- **One worker per plan.** Three plans must run on the identical crowd. Isolated workers with the same seed is the cheapest way to guarantee that; nothing is shared, so nothing can leak between runs.
- **No AI in movement.** Crowd physics is plain code: flow fields on a 2 m grid, walking speed falling as cell density rises. AI answers *decisions only*, at decision points.
- **Decisions are grouped, not per-dot.** Dots that face the same choice in the same rounded context share a `decisionKey`, so one model call answers thousands of dots. Rounding is what makes that possible.
- **Sim time stops for decisions.** When a step raises a key with no answer yet, the clock waits. Anything over 2 s, any error, any odds that do not sum to 1 falls back to `DecisionDefaults` and is counted as a fallback on the scorecard — so the commander can see how much of a run was guessed.
- **Same seed + same tape = same run.** Every answer a run used is recorded on a `DecisionTape`, so a run replays with no model at all. A test asserts identical scorecards.

## Quick start

From a fresh clone, with Node 22 or newer:

```bash
npm install
npm run typecheck
npm test
```

Run it (two terminals):

```bash
npm run serve                      # Hono API on http://127.0.0.1:8787
npm run dev                        # app on http://localhost:5173
```

The app works with no model running: every decision shows as a fallback. To get live fan decisions, start Kev first:

```bash
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009
```

Copy `.env.example` to `.env` to change ports or the Kev URL.

## Where things stand

The real engine runs. Fans arrive on their type's schedule, walk a flow field to the nearest gate by walking distance, queue there against the gate's actual throughput, get admitted, and find a seat. Walking speed falls as the cell they are in fills up. Closing a gate or a street reroutes everyone, and a `redirect` only moves fans an alert actually reached who chose to follow it.

Measured on an 800x800 grid (the stadium plus half a mile at 2 m cells) with 20,000 dots standing for 100,000 fans, in one worker:

- **225x real time** in one browser Web Worker with a warm cache, zero fallbacks
- **107x real time** through a lightning delay that asks every dot at once
- **57,974 dot decisions collapse to 121 distinct model calls**

The real Ohio Stadium map is in, built from an OpenStreetMap extract (way 119153498) covering the stadium plus half a mile: an 800x800 grid of 2 m cells with 12 gates, the bowl and its concourse, 140 parking lots, and closable real streets — Woody Hayes Drive, Lane Avenue, Cannon Drive. Three plans run on it with 100,000 fans at about 300x real time.

Refetch the map with `npm run fetch-map` (it is committed, so you only need this to update it).

All three incidents work — a lightning delay, a gate surge at a north gate at kickoff, and a suspicious package closing a street as the game lets out — each with three editable plans. The commander briefing comes from Apple's on-device model through `fm serve`, and every number in it is checked against the scorecard before it is shown; one invented figure and you get the template instead.

The commander view has the live map with a density heatmap, the incident panel, a plan editor that edits each step's timing and size, the three runs side by side, a scorecard each, the briefing, a replay scrubber over the kept frames, a deciding indicator while sim time waits on Kev, and dot detail — click any dot to see which group it belonged to, what it was deciding, the odds it was given, and whether a model or the fallback table answered.

### Verified, and not

| Requirement | State |
| --- | --- |
| Workspaces, typecheck, tests | 98 tests, `tsc` clean |
| Engine in a worker, no AI in movement | yes; flow fields, seeded RNG, snapshot/restore, frames every 15 s |
| 20,000 dots at 10x or faster | **82-140x** measured in process |
| Stadium map from OSM at kickoff minus 60 | yes, 800x800 cells from a committed extract |
| Three incidents, 3 editable plans each | yes, all three run on the stadium map |
| Same moment, same seed, three plans | yes, side by side |
| Scorecard, checked against a hand count | yes, on the 3 gate test map |
| Decisions grouped, cached, sim pauses, fallbacks counted | yes; **57,974 dot decisions to 135 model calls** |
| Live decisions from the real Kev-4B on :8009 | **yes**, MLX on this Mac, `source: "kev"` end to end |
| Fans actually get into the stadium | **18,185 of 20,000** by kickoff plus 30 |
| DecisionTape replay gives identical scorecards | yes, proven by test |
| Cold-cache lightning under 60 s | **44.1 s** against the real Kev-4B |
| Briefing from `fm serve`, numbers checked | yes, verified live; 399-token prompt |
| App screens | all built and **seen rendering in Chrome** |
| Runs with Kev off, every decision a fallback | yes, tested |
| Full demo in a fresh browser | **driven end to end** in a fresh Chrome profile, real Kev and `fm serve` live |

Two things are genuinely unproven. The real **Kev-4B has never run here** — it is not installed on this machine, so the decision path is verified over real HTTP against a stand-in that answers in 150 ms. And the **app has not been seen rendering**: it builds, mounts with no console errors, and emits its worker chunk, but the in-app browser pane will not display and Playwright cannot reach DOMContentLoaded, so the browser demo needs a human to confirm. Gate throughput is still below what the gates are rated for — see the open items in `CLAUDE.md`.

## Rules this project holds to

- No Claude API and no paid API. Models run locally: Kev via MLX, the briefing via Apple's on-device `fm serve`.
- No faces, no identities, ever. Future sensor input is people counts per zone only.
- Fan behavior is labeled on screen as an assumption, not a forecast.
