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

Milestone 1 is in: workspaces, the frozen contract wired through every lane, the tiny 3-gate test map, one gate-surge incident with three editable plans, even-odds decisions with the full pause/fallback/tape path, a seeded engine with snapshot and restore, the Hono server with the contract's routes, and the Pixi app drawing three runs side by side.

Movement is still a stand-in: dots orbit where they spawned so every other lane could be built against real `TickFrame`s. Flow fields and density-limited walking speed are next, then the stadium map, then all three incidents with the briefing and replay.

## Rules this project holds to

- No Claude API and no paid API. Models run locally: Kev via MLX, the briefing via Apple's on-device `fm serve`.
- No faces, no identities, ever. Future sensor input is people counts per zone only.
- Fan behavior is labeled on screen as an assumption, not a forecast.
