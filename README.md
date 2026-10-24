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

From a fresh clone. The project runs TypeScript directly with no build step
(`node server/src/index.ts`), so it needs a Node whose type stripping is on by
default — **Node 23.6 or newer**; developed and tested on 26.12.

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

Everything above works with no configuration. `.env.example` documents all
thirteen environment variables the code reads, each with its default and why you
might change it; copy it to `.env` only if you need to move a port or a model URL.

Before a demo, warm the decision cache so fans are answered by the model rather
than the fallback table — `npm run warm`. The shipped seed already covers the
three scenarios, so this is only needed after changing the decision vocabulary.

## Where things stand

The real engine runs. Fans arrive on their type's schedule, walk a flow field to the nearest gate by walking distance, queue there against the gate's actual throughput, get admitted, and find a seat. Walking speed falls as the cell they are in fills up. Closing a gate or a street reroutes everyone, and a `redirect` only moves fans an alert actually reached who chose to follow it.

Measured on an 800x800 grid (the stadium plus half a mile at 2 m cells) with 20,000 dots standing for 100,000 fans, in one worker:

- **222x real time** in one browser Web Worker with a warm cache, zero fallbacks
- **103x real time** through a lightning delay that asks every dot at once
- **57,974 dot decisions collapse to about 144 distinct model calls**

The real Ohio Stadium map is in, built from an OpenStreetMap extract (way 119153498) covering the stadium plus half a mile: an 800x800 grid of 2 m cells with 12 gates, the bowl and its concourse, 140 parking lots, and closable real streets — Woody Hayes Drive, Lane Avenue, Cannon Drive. Three plans run on it side by side with 100,000 fans at **56.8x real time each** — and that is the UI's speed setting, not the engine's ceiling.

Refetch the map with `npm run fetch-map` (it is committed, so you only need this to update it).

All three incidents work — a lightning delay, a gate surge at a north gate at kickoff, and a suspicious package closing a street as the game lets out — each with three editable plans. The commander briefing comes from Apple's on-device model through `fm serve`, and every number in it is checked against the scorecard before it is shown; one invented figure and you get the template instead.

The commander view has the live map with a density heatmap, the incident panel, a plan editor that edits each step's timing and size, the three runs side by side, a scorecard each, the briefing, a replay scrubber over the kept frames, a deciding indicator while sim time waits on Kev, and dot detail — click any dot to see which group it belonged to, what it was deciding, the odds it was given, and whether a model or the fallback table answered.

### The demo, driven end to end

Last run in a fresh Chrome profile with Kev-4B and `fm serve` both live, on the real stadium map with 100,000 fans:

| | Plan A, six officers | Plan B, open Gate 2 + PA | Plan C, close Gate 1 |
| --- | --- | --- | --- |
| time to clear | **6 min** | 9 min | **never** |
| decisions | 121 | 10,254 | 11,250 |
| peak density | 5.00 /m² | 5.00 /m² | 5.00 /m² |
| officer minutes | 180 | 60 | 120 |
| fans not reached | 100,000 | 99,205 | 49,935 |
| fallback decisions | **0** | **0** | **0** |

Three workers, 20,000 dots each, ran those 90 simulated minutes in 95 seconds — **56.8x real time per plan** against a 10x bar, and that is the UI's speed setting rather than the engine's limit; unpaced in one worker it reaches 222x.

Closing the hot gate never clears it — the crowd piles up outside. Opening a relief gate reaches almost everyone but takes longer. Six officers clears fastest and reaches nobody. That is the tradeoff the commander is being shown, and the briefing underneath it is written by the on-device model from those numbers alone.

The three **lightning delay** plans separate too, which they did not until officers
were made to change what the crowd does rather than only to cost officer minutes:

| | danger minutes | fallback decisions |
| --- | --- | --- |
| A, shelter order + PA | 284,704 | 144 |
| B, gates open + officers on the gates | **278,758** | 1,021 |
| C, phone alert, shelter order at two minutes | 283,901 | 514 |

B buys the lowest danger minutes, and gets roughly 1,300 more fans out of the
open, by spending officers and far more model decisions. A is nearly as safe for
a fraction of both. Again: a tradeoff, not a recommendation.

### Verified, and not

| Requirement | State |
| --- | --- |
| Workspaces, typecheck, tests | **115 tests in 16 files**, `tsc` clean |
| Engine in a worker, no AI in movement | yes; flow fields, seeded RNG, frames every 15 s, snapshot **and** seek-to-rewind exercised through the worker |
| 20,000 dots at 10x or faster | **222x** in one browser worker, **56.8x** per plan with three running in the app |
| Stadium map from OSM at kickoff minus 60 | yes, 800x800 cells from a committed extract |
| Three incidents, 3 editable plans each | yes, all three run on the stadium map |
| Same moment, same seed, three plans | yes, side by side |
| Scorecard, checked against a hand count | yes, on the 3 gate test map |
| Decisions grouped, cached, sim pauses, fallbacks counted | yes; **57,974 dot decisions to about 144 model calls** |
| Live decisions from the real Kev-4B on :8009 | **yes**, MLX on this Mac, `source: "kev"` end to end |
| Fans actually get into the stadium | **18,185 of 20,000** by kickoff plus 30 |
| DecisionTape replay gives identical scorecards | yes, proven by test |
| Cold-cache lightning under 60 s | **43.2 s** against the real Kev-4B |
| Briefing from `fm serve`, numbers checked | yes, verified live; 399-token prompt |
| App screens | all built and **seen rendering in Chrome** |
| Runs with Kev off, every decision a fallback | yes, tested |
| Full demo in a fresh browser | **run in the Mac's own default browser** via `open`, no flags or debugger; verified by the comparison the server saved. Chrome and the default browser both complete; **Safari does not** — see below |

One thing is unresolved, and it is a browser, not the build. **Safari had not finished a run**, and the cause was almost certainly the worker's pacing loop: it slept once per simulated second, and Safari clamps timers to about a second in a tab whose app is not frontmost, which paced a 90 minute scenario at real time. That loop now makes up every step the wall clock owes before sleeping, so a clamped timer costs fewer, bigger batches rather than a slower run — and the same change took the Chrome bench from 222.5x to 254.4x. **Whether Safari now completes has not been confirmed:** the verifying run was cut short. **Demo in Chrome.**

Everything else above was watched happening. `CLAUDE.md` carries the remaining open items, the largest being that a cold cache is mostly fallbacks for its first eighty seconds while the background warmer catches up.

## Rules this project holds to

- No Claude API and no paid API. Models run locally: Kev via MLX, the briefing via Apple's on-device `fm serve`.
- No faces, no identities, ever. Future sensor input is people counts per zone only.
- Fan behavior is labeled on screen as an assumption, not a forecast.
