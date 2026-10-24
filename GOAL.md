# Goal

Build **Gameday Command**, a practice tool for police commanders who run game day at Ohio Stadium. It simulates the crowd around the stadium. The commander triggers an incident, then runs the same moment under up to three response plans side by side and sees a scorecard for each. The commander always makes the call. The tool shows tradeoffs and never tells police what to do.

This is for HackOHI/O (24 hours, Saturday 10 AM to Sunday 10 AM). A working demo beats extra features every time.

## Read first

1. `contracts.ts` in the repo root. It is the frozen shared contract. Do not change it without asking me. If something truly cannot work with it, stop and explain why.
2. The spec doc ("Gameday Command Spec") if I paste it in.

## The demo this must deliver (3 minutes)

1. Load the stadium area at kickoff minus 60 minutes, 100,000 fans drawn as 20,000 dots (one dot = 5 fans).
2. Commander drops an incident on the map. Three incidents must work.
    - Lightning delay. Everyone in the stands shelters at once.
    - Gate surge at kickoff. A late crowd piles into one north gate.
    - Suspicious package. A street closes as the game lets out.
3. Commander picks up to three response plans from a playbook and edits them (close or open a gate, send officers to a place, PA or phone alert, redirect, shelter order).
4. The app copies the same moment three times, same crowd and same seed, and runs all three plans side by side.
5. Scorecard per plan. Time to clear, peak density (people per square meter), danger minutes (cells above 4 people per square meter, editable), first officer on scene, officer minutes used, fans not reached, fallback decisions.
6. A plain language briefing explains the tradeoffs using only scorecard numbers.
7. Replay scrubber, and clicking a dot shows why that group moved.

## Architecture (everything runs on one 32 GB Mac)

- **Repo** is npm workspaces, TypeScript everywhere, Node 22 or newer. Folders `/engine`, `/world`, `/brain`, `/app`, `/server`, with `contracts.ts` at the root.
- **Engine (`/engine`)** runs in a browser Web Worker, one worker per plan. Plain code only, no AI. Flow fields per destination on a 2 m grid, and walking speed drops as cell density rises. Typed arrays for dot state. Seeded random number generator. Snapshot and restore. Replay frames every 15 sim seconds.
- **World (`/world`)** holds the OpenStreetMap stadium map (stadium plus about half a mile), incident types, officer agents, playbook plans and scoring. It changes the world only through `WorldHooks` and `WorldActions` in the contract.
- **Brain (`/brain`)** handles fan types (about 40), situations (about 15) and the decision client. Dots that hit a decision are grouped by `decisionKey` (fan type, situation, rounded context), and one call answers the whole group.
- **Live decisions** come from Kev-4B served locally with MLX on port 8009 (`uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009`). Kev returns a probability for each option. Sim time pauses at the step until answers arrive, then dots sample with the seeded generator. Answers over 2 seconds, errors, or odds that do not add up to 1 fall back to `DecisionDefaults` and count as fallbacks on the scorecard. Every answer goes on a `DecisionTape` so a run can be replayed with no AI.
- **Server (`/server`)** is Hono and better-sqlite3 on the Mac. Routes are in the `Api` interface in the contract. `POST /decide` checks the cache, then asks Kev. Plans, results and the decision cache live in SQLite.
- **Briefing** uses Apple's on-device model through `fm serve` (OpenAI compatible). Always send `stream: false`. Keep prompts under 4k tokens (the real limit is about 8k, and an overflow comes back as a fake safety error). Check every number in the briefing against the scorecard and fall back to a template if any number is not there.
- **App (`/app`)** is Vite, React and PixiJS 8. Screens are the live map with a density heatmap, incident panel, plan editor, three runs side by side, scorecard, briefing, replay scrubber, dot detail, and a "deciding" indicator while sim time waits on Kev.

## Hard rules

- Never use the Claude API or any paid API.
- No AI in crowd physics. AI only answers decisions at decision points.
- Same seed plus the same decision tape gives the exact same run. Test this.
- Never store or show faces or identities. Future sensor input is people counts per zone only.
- Fan behavior is labeled on screen as an assumption, not a forecast.
- No new heavy dependencies without asking me. Prefer writing 20 lines over adding a library.
- Commit small and often with clear messages. Keep `npm run typecheck` and `npm test` passing on every commit.

## Milestones (hours from Saturday 10 AM)

1. **Hour 1.** Workspaces set up, `contracts.ts` in place, a stub for every lane. That means a fake engine moving dots in circles that emits real `TickFrame`s, a tiny 3 gate test map, one fake incident, even odds decisions, and the map screen drawing the fake frames.
2. **Hour 8.** The real engine draws on the map with the tiny test map. Flow fields and density speed work.
3. **Hour 14.** Full flow works end to end on the stadium map with one incident, three plans side by side and a scorecard. Kev answers live.
4. **Hour 20.** Feature freeze. All three incidents, briefing, replay. After this only bug fixes and demo setup.
5. **Hour 24.** Submit.

## Done means

- 20,000 dots run at 10x real time or faster in one Web Worker with a warm cache.
- A lightning delay with a cold cache resolves in under 60 seconds of wall time.
- The same seed and tape give identical scorecards across three runs (a Vitest test proves it).
- The scorecard matches a hand count on the tiny test map (a Vitest test proves it).
- The full demo flow works in a fresh browser on the Mac with Kev and `fm serve` running.
- If Kev is off, the app still runs on defaults and shows every decision as a fallback instead of crashing.

## How to work with me

- Start each milestone by telling me in a few lines what you will build and in what order, then build it.
- When a choice is close, pick the simpler one and tell me why in one sentence.
- If you are blocked for more than about 15 minutes on one thing, stop and tell me what you tried.
- Begin with Milestone 1.
