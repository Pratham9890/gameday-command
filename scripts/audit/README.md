# Walkthrough harness (`walkthrough.mjs`)

A scripted tour of the real app in headless Chromium. It doubles as an end-to-end
smoke test and as the evidence collector for the persona audit
(`docs/research/05-persona-audit.md`). One Node process starts the API server and
Vite, drives the browser through the flows you name, writes artifacts, then stops
everything. No npm dependencies: playwright-core and Chromium come from the sandbox.

## Run it

```bash
source /projects/sandbox/.kiro/env.sh        # sets GD_CHROMIUM and GD_PLAYWRIGHT_CORE
cd /projects/sandbox/gameday-command
node scripts/audit/walkthrough.mjs --list    # flows, groups, and what is missing or failed
node scripts/audit/walkthrough.mjs inspectors police --max-minutes=14
node scripts/audit/walkthrough.mjs missing   # only flows with no result yet
node scripts/audit/walkthrough.mjs all --strict --max-minutes=25
```

Run it in the foreground, inside one shell call: background processes do not
survive the end of a call in this sandbox. Keep `--max-minutes` below the
call's own timeout so the run finishes cleanly and writes its index.

Exit codes: `0` all flows ran (check failures are findings, not errors), `1` a
step errored (or a check failed with `--strict`), `2` bad arguments or a
startup failure, `3` the `--max-minutes` backstop fired.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--list` | | List flows and groups, including `missing` and `failed` from `index.json`, then exit |
| `--speed=5\|20\|60` | `60` | The app's speed button to press |
| `--timebox=SECONDS` | 180 (package 360) | Wall-clock cap for each incident run |
| `--max-minutes=N` | `25` | Budget for the whole call. Flows that no longer fit are recorded as `skipped`; a flow cut short is `cut-off`; children are always stopped |
| `--no-shots` | | No screenshots (text, aria and summaries are still written) |
| `--shot-cap=N` | `45` | Cap on `audit-*.jpg` files in the screenshots folder, counted across calls |
| `--repo-data` | | Use the repo's `data/gameday.db` and `data/stadiums` instead of an isolated copy |
| `--base-url=URL` | | Drive an app that is already running; spawn nothing |
| `--headed` | | Show the browser (needs a display) |
| `--strict` | | Exit 1 when any check fails |

Environment: `GD_CHROMIUM`, `GD_PLAYWRIGHT_CORE` (required); `GD_AUDIT_OUT`,
`GD_AUDIT_SHOTS` (optional, move the artifacts).

## Flows

| Flow | What it does | Typical time |
| --- | --- | --- |
| `start` | Demo sign-in dialog, start screen, OpenStreetMap search and import (Beaver Stadium) | 1–4 min (import depends on public Overpass servers) |
| `views` | 3D close-up, 2D plan, all three side by side; dark and light; frame rate; density-band filter | 1.5 min |
| `tabs` | Every side-rail tab on a live run (rail size metrics), real-conditions panel, "Build three plans" | 1.5 min |
| `incident-surge` | Gate surge to completion: verdict, ranking by each priority, plan cards, replay, feedback, rewind | 2 min |
| `incident-lightning` | Lightning delay to completion, same checks without feedback/rewind | 2.5 min |
| `incident-package` | Suspicious package at game end (a 4.5 h simulated window; see limits) | up to 7 min |
| `incident-game-end` | Egress from the final whistle to completion | 1.5 min |
| `plan-editor` | Edit a step, add a step, restart, run past the alert, reload | 1.5 min |
| `inspectors` | Click a fan, a vehicle and an officer on the 3D map; arm and cancel a map pick | 1 min |
| `police` | Orders tab: dispatch a suggestion, barricade, medical marker, PA alert, redirect, close a gate, undo, JSON export, after-action print, release confirm | 2 min |
| `officer` | Phone (390x844, touch): demo sign-in as an officer, acknowledge, backup, report on the map, switch to supervisor, send the nearest free unit | 1.5 min |
| `keyboard` | Keyboard-only pass: tab order, focus rings, traps, rail-tab ARIA pattern, map reachability | 1 min |

Groups: `all`, `quick` (start views tabs keyboard), `interact` (plan-editor
inspectors police officer), `incidents`, plus `missing` and `failed`, which are
computed from `index.json`.

## Artifacts

```
.kiro/artifacts/audit/
  index.json                 every flow's last status, failed checks, step errors; environment; screenshot count
  <flow>/summary.json        steps (result, sim state, timings), checks, notes, metrics, page errors, HTTP errors
  <flow>/NN-step.txt         page text after each step
  <flow>/NN-step.aria.yaml   accessibility tree after each step
  <flow>/console.json        console errors and warnings
  police/timeline-export.json, police/after-action.html   the app's own exports
  officer/ ... metrics.phone-fit                           what makes the phone page overflow
  _server/                   isolated database, imported stadiums, server.log, vite.log
.kiro/artifacts/screenshots/audit-<flow>-<step>.jpg        JPEG, quality 70
```

Re-running a flow deletes that flow's old folder and screenshots first; the
index is merged after every flow, so separate calls add up and a call that is
cut off still keeps what it finished.

## How children are kept from leaking

- Both children (API server, Vite) are spawned detached, each leading its own
  process group, and are stopped with SIGTERM then SIGKILL on success, error,
  signal or uncaught exception; the harness then checks ports 8787 and 5173 are free.
- Each child is started with `node --import <watchdog>`: it polls its parent
  once a second and kills its own process group when the harness is gone, even
  after a SIGKILL that no exit handler can catch.
- `--max-minutes` caps every flow to the time left and a backstop timer stops
  the run 15 s after the budget, so an outer timeout never cuts it mid-flow.

## Known limits

- Rendering is SwiftShader (CPU). Frame rates in `views` (1–3 fps) say nothing
  about a real GPU; use them only to compare views with each other.
- Kev (port 8009) is not running here, so fan decisions come from the cache
  and the defaults table. Something answers on 8080 but is not Apple `fm serve`,
  so every briefing is the template.
- `start` needs the public Overpass API; when every mirror fails, the import
  check fails (that is the app's behaviour, reported as a finding).
- `incident-package` simulates from 60 min before kickoff to 240 min after it;
  the app keeps every density frame and the page runs out of memory around
  t = 12,100 s. The flow detects that, records it and stops early.
- Phone emulation: the officer page is wider than 390 px, so the layout viewport
  is 506 px and Playwright's touch coordinates land off target. `tapControl`
  records the hit test, then clicks through the DOM so the rest of the flow
  still runs; the map report falls back to synthetic pointer events. Both are
  noted in the step results.
- In-page probes read `window.gameday` and `window.gamedayScene`, which the app
  publishes for unattended checks; private TypeScript members are read at run time.

## Adding a flow

Write `async function flowX(f)` using `openOhio(f)`, `f.step(name, fn, { shot })`
and `f.check(name, ok, detail)`, then add it to `FLOWS` with a `maxMin` cap.
Steps never throw: errors are recorded and the flow carries on. Keep the
screenshot cap in mind (`shot: true` only where a picture is evidence).
