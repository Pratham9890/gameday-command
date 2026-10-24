# TODO — Gameday Command v3

Status: **Phase 0 done except the branch-name note; Phase 1 next.** Branch `feat/command-v3` off `1d48d31`.
Checked boxes are verified in this repo, not merely written.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done and tested.

---

## Phase 0 — baseline on Windows

- [x] Create `feat/command-v3` from `main` @ `1d48d31`.
- [x] Push `backup/isometric-ui` (our old app) for history only.
- [x] Replace `better-sqlite3` with built-in `node:sqlite` in `server/src/db.ts`.
      Acceptance: `npm install` completes on Windows with no Visual Studio and no native build.
- [x] Drop `better-sqlite3` from `package.json` / `allowScripts`.
- [x] Normalise server file paths so `data/decision-seed.json` resolves with `\` or `/`.
      Also fixed: the `index.ts` main guard, so `npm run serve` starts on Windows.
- [x] `npm run typecheck` clean.
- [x] `npm test` green; record test-file and test-case counts in `CONTEXT.md`.
- [ ] `npm run seed:export` needs the `sqlite3` CLI and bash syntax; port it to a Node script
      over `node:sqlite` if a re-warm is ever done on Windows.
- [ ] Remove the unused probe branch name from any notes; only `main`, `feat/command-v3`,
      `backup/isometric-ui` on the remote.

---

## Phase 1 — honesty and small gaps

- [ ] **Ratio on screen.** HUD and legend read `1 dot = 5 fans · 20,000 dots · 100,000 fans`.
      Acceptance: the numbers come from `fanCount(map)` and `dots.length`, not typed literals.
- [ ] **Synthetic banner.** A persistent, dismissible strip: "Crowd, traffic and sensors are
      synthetic. The forecast is a model, not an observation."
      Acceptance: visible on first load; survives every screen; no claim of live data.
- [ ] **Tailgate places.** Derive reserved tailgate zones from OSM parking areas near the stadium
      and emit `kind: 'tailgate'` places in the map bundle.
      Acceptance: at least one tailgate place per near-stadium lot cluster; a unit test asserts
      ids, cells and that every cell is walkable.
- [ ] **Officer roster (read-only).** Panel listing every officer: unit, post, current order,
      ETA, fans spoken to, follow rate.
      Acceptance: roster count equals officer markers; values update on a new frame.
- [ ] **Day clock + full-day scrubber.** 05:00–21:00 phases from `dayScript.ts`, wired to the
      replay scrubber; kickoff formatting.
      Acceptance: dragging to 15:30 shows "Kickoff" and engine `t = 0`.
- [ ] **Zone table.** Ranked zones by people, trend, and time-to-threshold (4 p/m²).
      Acceptance: every value changes when the clock advances 15 minutes.
- [ ] **Lot board.** Occupancy per parking place from the density grid.
      Acceptance: values rise 05:00 → 15:30; computed, never typed.

---

## Phase 2 — six interventions + officer orders

Presets compile to frozen contract steps; no `contracts.ts` change.

- [ ] **Intervention builder** (`app/src/interventions.ts`): named presets → `PlanStep[]`.
      Acceptance: a unit test compiles each preset and asserts the exact steps.
- [ ] **Close / open road** → `close` / `open` on a street closable.
- [ ] **Post officers** → `send_officers` / `hold_officers`, dispatchable from the roster.
- [ ] **Gate / lane control** → `close` / `open` plus a gate throughput edit.
- [ ] **Lot diversion** → `redirect` lot → lot plus `alert`.
- [ ] **Pedestrianize street** → engine-private `edits.ts` message: vehicles blocked, walkers
      allowed. Acceptance: a pedestrianized street still carries walkers and carries no vehicles.
- [ ] **Alert channels** → presets for PA, phone, officer radio, message board.
      Acceptance: each maps to a valid contract `alert` (radio/message board documented as
      composites until a contract v3 exists).
- [ ] **Officer orders.** Dispatch, ack, and state ("en route", "on scene", "spoken to N").
      Acceptance: an order changes the officer's target and the scorecard shows officer minutes.
- [ ] **Interventions map to engine parameters** (carried over). Closing Woody Hayes Drive changes
      the walkable mask and measurably lengthens at least one dot's path to its gate.
- [ ] **Officer posting changes decision probabilities** (carried over). With an officer on a gate
      approach, the recorded comply probability is higher than without.
- [ ] **Placement commits to the simulation** (carried over). A barrier changes the T+15 peak by
      >0.1 p/m², or measurably increases mean path length.
- [ ] **Candidate generation and ranking** (carried over). 20–60 unique plans covering all six
      kinds; a plan that worsens the crowd ranks last; repeated calls are identical.
- [ ] **Per-preset scorecard test** on the 3-gate map: each preset moves at least one number.

---

## Phase 3 — forecast, assimilation, receding horizon

- [ ] **Spike: forecast cost.** Snapshot at T, run 6 variants × 600 s at 5k dots; measure wall
      time. If >1.5 s, drop to 4 variants and record the decision.
- [ ] **`engine/src/forecast.ts`** + worker message in `edits.ts`: checkpoint → variants
      (seed, compliance, arrival shift, weather) → zone curves every 30 s.
      Acceptance: same checkpoint + seed → identical bands; test proves it.
- [ ] **Forward-run prediction from current state** (carried over). T+15 differs from now by
      >0.1 p/m² in at least one zone.
- [ ] **Ensemble combine with a 10/90 spread** (carried over). p10 ≤ centre ≤ p90 for every zone;
      `peakDensity` is the max centre, not the mean of variant peaks.
- [ ] **Ensemble reweighting** (carried over). After one observation, the matching variant carries
      >2× the weight of a far-off one; weights sum to 1 within 1e-9.
- [ ] **Observation model** (carried over). `observe.ts` noise, latency, dropout, partial coverage;
      no coverage → no observation; same seed → byte-identical arrays.
- [ ] **Resampling with a collapse guard** (carried over). ESS stays >1.5; no identical clones.
- [ ] **Measured vs inferred zones look different** (carried over). Hatched/dashed fill plus an
      "inferred" label; legend reads "N of M zones instrumented".
- [ ] **Prediction ghost layer** (carried over). T+15 positions at reduced opacity with a dashed
      contour; one screenshot shows observed and predicted together.
- [ ] **Time-to-threshold countdown per zone** (carried over). Rising zone → finite countdown;
      stable zone → em dash.
- [ ] **Confidence from the ensemble** (carried over). Replace any constant "19 of 20" with the
      computed improving share; it changes when observations reweight.
- [ ] **Approve or deny records the decision** (carried over). Approve writes a record whose
      numbers match the forecast; deny leaves the sim unchanged.
- [ ] **Commit → truth advances → re-predict** (carried over). After a commit the forecast changes
      while paused, in the direction the pre-commit projection predicted.
- [ ] **Plan diff panel** (carried over). Peak, danger minutes, officer cost, approve/deny; numbers
      come from the forecast API, not a parallel calculation.
- [ ] **Decision tape replay is deterministic** (carried over). Replaying a tape reproduces
      byte-identical positions and scorecard.
- [ ] **Decision provider chain** (carried over). cache → Kev → heuristic; every record reports
      `source`; odds sum to 1.
- [ ] **Logit wrapper + monotonicity test** (carried over). Longer queue never raises that
      option's probability; an officer raises comply probability.
- [ ] **Forecast skill vs truth** (carried over). Finite MAE at T+15 and regret after one commit.
- [ ] **Kev endpoint + adaptive concurrency.** `KEV_URL` accepts any TypeSafe-compatible server;
      concurrency rises while latency is under budget and backs off on timeout.
- [ ] **Band UI.** p10/p50/p90 on the map and a per-zone fan chart; legend says forecast.

---

## Phase 4 — bug fixes, research, docs

- [ ] **Danger scoring.** Count near the incident plus spillover so plans separate by >5 % on at
      least two incidents (`world/src/scoring.ts`).
- [ ] **Lightning and package clearance.** Both currently never clear their zones; fix the
      clearance condition and test it.
- [ ] **`pick_gate` as a Kev decision** (upstream open item).
- [ ] **Research note** (`docs/forecast.md`): ensemble sizing, band vs HOP presentation,
      calibration metrics, what we may and may not claim.
- [ ] **Docs.** Update `README.md` and `CLAUDE.md` with the forecast architecture and measured
      numbers; refresh `CONTEXT.md` at the end of each phase.

---

## Closed by the pivot (do not do)

Their app already does these; our versions are obsolete.

- [x] Play / pause / speed on the real clock — shipped in `2f50690`.
- [x] Layered people instead of one flat sprite — `crowd-scene.ts` parts.
- [x] Minimum on-screen person size — `PEOPLE_MIN_SCALE`.
- [x] Interpolate between engine frames — frame tweening in `CrowdScene.setFrame`.
- [x] Crowd occupies lots and plazas — their arrivals and lots model.
- [x] Engine drives the renderer — done in the old repo, then dropped with the renderer.
- [x] App test suite in `package.json` — theirs already has vitest.

---

## Carried-over index

24 live items from the old backlog are folded into Phases 1–3 above and marked
"(carried over)". The 7 closed ones sit in the section above. The old plan remains in Project
knowledge as history; this file is the executable list from now on.
