# Gameday Command v3: master plan

Status: approved for build, 27 Oct 2026. Owner: integration lead (the coordinating agent). The evidence behind every decision is in `docs/research/`:

| Doc | Covers | Requirement IDs |
| --- | --- | --- |
| [01-domain-practice](../research/01-domain-practice.md) | How crowd-safety and event-command tools work; NIMS/ICS, HSEEP, NCS4, CISA, Green Guide, lightning and heat; Ohio Stadium facts | DOM-01 to DOM-35 |
| [02-engine](../research/02-engine.md) | Pedestrian and vehicle models, calibration data, the V&V suites, Rust/WASM architecture, measured benchmarks | ENG-01 to ENG-27 |
| [03-video-analytics](../research/03-video-analytics.md) | On-device crowd density, flow and vehicles from video, privacy by design, the licence table | VID-01 to VID-30 |
| [04-map-and-ui](../research/04-map-and-ui.md) | MapLibre and deck.gl stack, offline basemap, symbology, ISA-101 HMI, alarms, accessibility | MAP-01 to MAP-18, UI-01 to UI-24 |
| [05-persona-audit](../research/05-persona-audit.md) | Ten personas run against the current app in a browser: gap matrix, 37 defects | PER-01 to PER-34, D-01 to D-37 |
| [06-platform-integrations](../research/06-platform-integrations.md) | Deployment, security, roles, audit, collaboration, feeds, ICS and HSEEP products, resilience, QA | PLT-01 to PLT-50 |

## 1. What v3 is

**Gameday Command is decision support for game-day public safety at a large stadium.** Commanders and their staff use it to plan, rehearse and exercise responses, and to keep a labelled picture of the crowd on the day. It runs one moment under several plans on the same crowd and shows the tradeoffs with their uncertainty. The commander decides; the tool never phrases output as an order.

It follows the operating rhythm police already use (the Planning P, then HSEEP):

| Mode | Who | What they do |
| --- | --- | --- |
| **Plan** | Commander, section chiefs, traffic, gates, EMS, venue | Build the venue picture, the posts and sectors, the closures, the screening lanes; draft plans as ICS 202 objectives and 204 assignments; export the Event Action Plan |
| **Rehearse** | Commander, planners | Drop or author an incident; run up to three plans on the same crowd as a seed ensemble; compare outcomes with ranges; record the choice and why |
| **Exercise** | Training officer, controllers, evaluators, players | Run an HSEEP tabletop: objectives, MSEL and injects, players on their own devices, evaluator notes, AAR/IP |
| **Live** | Commander, RTCC analyst, gate and traffic supervisors | A common operating picture with video- and feed-derived estimates (counts only, no identities) beside the simulation, labelled by provenance; alarms for decisions only |
| **Review** | Everyone | Replay, branch, hot wash, after-action report, reproducible exports |
| **Field** (separate light route) | Patrol officers | Assignment, status, route, report, backup on a phone, one-handed |

**It is not** CAD, dispatch, radio, mass notification, surveillance or identification, evidence, or a forecast unless a calibration says so. The start screen, the About panel and every export footer say this (PLT-50).

### Users

From the persona audit (§2 there). Primary mode in bold.

| ID | Persona | Modes | Top needs |
| --- | --- | --- | --- |
| P1 | Incident/Event Commander (OSU PD captain, Unified Command) | **Rehearse**, Plan, Live, Review | One trustworthy comparison with ranges; ICS 201 brief; decision log |
| P2 | Operations Section Chief | **Plan**, Live | Sectors, posts, unit types, a status board, a request queue with place and priority |
| P3 | Traffic Unit Sergeant | **Plan**, Rehearse | Closures with previews and schedules, contraflow, TCP staffing, lot clearance |
| P4 | Gate & Perimeter Supervisor | **Plan**, Live | Lane-level screening model, real gate names, waits in minutes, perimeter |
| P5 | Patrol Officer | **Field** | Assignment-first phone screen, self-status, report with place, works with gloves and in sun |
| P6 | EMS/Fire liaison | Plan, Rehearse | Aid stations, EMS units, access routes, casualty ranges, shelter capacity |
| P7 | Training & Exercise Officer | **Exercise**, Review | MSEL and injects, multi-seat, evaluator notes, AAR/IP, saved packages |
| P8 | RTCC / video analyst | **Live** | Camera registry, calibrated zone counts with uncertainty, sensor health, no faces |
| P9 | Venue Ops / Event Security Director | Plan, Live | Venue model (sections, portals, exits), lightning timer, shelter vs evacuate, message library |
| P10 | City Emergency Manager / EOC liaison | Live, Review | Read-only shared view, situation report, GeoJSON/KML, regional picture |

## 2. Rules that bind every workstream

Hard rules (from `GOAL.md` and the brief; never broken):

1. No paid or cloud AI API. Models run locally and are optional; everything works on defaults.
2. No faces, no identities, ever. Video produces counts, densities and flows per zone. No face detection, recognition, re-identification, cross-camera tracking of people, plate reading or demographic attributes. Pixels never leave the vision worker and are never persisted by default.
3. No AI in crowd physics. AI only answers discrete decisions, and every answer goes on a tape.
4. Same seed, same decision tape and same observation tape give the same run, bit for bit, in Chrome and in Node. Tested.
5. Fan behaviour is labelled an assumption. Video numbers are labelled estimates with ranges. Forecasts are labelled forecasts.
6. Tradeoffs, never orders. A lint test rejects imperative advice in generated copy (UI-10).
7. Permissive licences only (MIT, BSD, Apache-2.0, ISC, MPL-2.0, OFL for fonts, CC BY for data). Every new dependency, model weight and dataset goes in `docs/licences.md`. GPL, AGPL and non-commercial items are flagged and kept out of the shipped app.
8. Nothing is invented: every number on screen comes from the run, a feed, a cited source or a labelled assumption.

Design principles (from 04 §10 and 01 §6):

1. The map is the instrument: one map-centric screen, docked panels, a bottom timeline.
2. Grey is normal. Colour marks abnormal states and the active plan; red means an alarm and nothing else. No team colours in operating views.
3. Every number says where it came from (simulated, estimated, forecast, assumed, default), how old it is and its range.
4. Few alarms, three priorities, only for decisions; phase-aware thresholds; the alarm rate is a tracked metric.
5. Situation awareness has fixed places: the map for perception, the status board for comprehension, the timeline for projection.
6. Compare like with like: same camera, ramp and legend across plans; small multiples, swipe, difference.
7. Shape, pattern and label before colour; it must read in greyscale print. CVD-safe ramps stepped at Fruin levels of service.
8. Plain police language (NIMS terms). Model internals live in About with definitions. Places are named (gate, section, lot, intersection), never offsets.
9. Built for the field and for walls: 48 px touch targets in the field route, day, night and wall themes, offline.
10. Keyboard first: a command palette, documented keys, a status board that is the map's text alternative. WCAG 2.2 AA.

## 3. Architecture

```
                    contracts.ts (gameday.v3 → v4 when per-person frames become default)
                                       │
  ┌──────────────┐  C-ABI wasm   ┌─────┴────────┐   hooks/actions   ┌──────────────┐
  │ engine-rs/   │◄─────────────►│ engine/ (TS) │◄─────────────────►│ world/       │
  │ Rust → wasm32│  typed arrays │ worker host, │                   │ venue model, │
  │ CSM people,  │               │ sim loop,    │   DecisionAsk ──► │ incidents,   │
  │ nav fields,  │               │ decisions,   │ ◄── answers       │ ICS plans,   │
  │ gate lanes,  │               │ orders,      │       │           │ scoring,     │
  │ IDM traffic, │               │ checkpoints  │  ┌────┴─────┐     │ weather      │
  │ metrics      │               └──────┬───────┘  │ brain/   │     └──────────────┘
  └──────────────┘                      │          └──────────┘
        ▲ same .wasm in Node worker_threads (ensembles, V&V, report-grade runs)
        │                               │ frames, scene, metrics (transferred)
  ┌─────┴───────────────────────────────▼──────────────────────────────────────────┐
  │ app/  React shell: modes, status board, inspector, timeline, palette, alarms   │
  │   ├─ map/     OpsMap: MapLibre 6 + deck.gl 9.4, PMTiles offline, 2D/3D, compare │
  │   ├─ vision/  Vision worker: video → ZoneObservation (counts only)              │
  │   └─ platform client: REST /api/v3 + WebSocket event log, offline outbox        │
  └───────────────────────────────────────┬─────────────────────────────────────────┘
                                          │ HTTPS / WSS (LAN or localhost)
  ┌───────────────────────────────────────▼─────────────────────────────────────────┐
  │ server/  Hono + node:sqlite + ws: auth, ICS-position RBAC, hash-chained audit,  │
  │ event log + presence, versioned scenarios/plans, feeds (NWS), exports (ICS      │
  │ forms, EAP, AAR/IP, GeoJSON/KML, CAP draft), decision cache → Kev → defaults    │
  └─────────────────────────────────────────────────────────────────────────────────┘
```

Deployment (PLT-01 to PLT-05): one server artefact serving the PWA, API, WebSocket, tiles and SQLite, in three modes: solo laptop (air-gapped tabletop), command-post LAN (game day, internet optional) and agency-hosted. The Vercel build stays a labelled public demo with synthetic data.

## 4. Decisions

| # | Decision | Why | Evidence |
| --- | --- | --- | --- |
| D1 | Product = decision support across Plan, Rehearse, Exercise, Live, Review, plus a Field route; not CAD, dispatch, alerting or surveillance | The app mixed a rehearsal tool, half a live-ops console and demo leftovers; professionals buy tools that fit the Planning P | 01 §2, §6; 05 bottom line |
| D2 | **Engine in Rust compiled to `wasm32-unknown-unknown`**, raw C-ABI exports, zero-copy typed-array views, one single-threaded worker per plan, the same `.wasm` in Node `worker_threads` | 10–23 ms per step for 100k agents measured in wasm; bit-identical native, wasm and 1/3/8 workers; no SharedArrayBuffer or nightly | 02 §6–§7 |
| D3 | **One agent per person** with the collision-free speed model (Tordeux), Δt 0.2 s integer ticks, decisions, density and scoring at 1 s; Dial u16 navigation fields; groups | Removes "1 dot = 5 fans" and the 1.25 p/m² density steps; collision-free and cheap at large Δt | 02 §1, ENG-01 to ENG-05 |
| D4 | **Gates are multi-lane screening servers** (ticket scan, walk-through metal detector, wand on alarm), service times sampled per lane, editable lane counts; Ohio Stadium is no-bag | Screening is the entry bottleneck and the gate supervisor's core decision | 02 §5, DOM-05, PER-03 |
| D5 | **Vehicles on an OSM lane graph with IDM + MOBIL**, signal/stop/yield/officer-controlled junctions, escape-only closures, contraflow with a flush | Today's cell cars cannot express lanes, signals or traffic control points | 02 §4, ENG-16 to ENG-19 |
| D6 | **Migration through adapters**: `WasmMovement` implements the existing `MovementModel`, later `WasmTraffic` replaces `TrafficModel`; `SimConfig.engine` selects `'ts'` or `'wasm'` until parity is signed off, then the TS movement and traffic code is deleted | World hooks, decisions, orders, checkpoints and scoring keep working while the hot path moves; existing tests become parity tests | 02 §8 migration |
| D7 | The built `.wasm` is committed with a manifest of its source hash; a test fails if sources change without a rebuild | Contributors without Rust can still run `npm run dev`, matching the no-build-step ethos | — |
| D8 | **Map: MapLibre GL JS 6.16 + deck.gl 9.4 via `@deck.gl/maplibre` `MapLibreOverlay` (interleaved)**, PMTiles offline OSU extract shipped, first-party day/night/wall styles from `@protomaps/basemaps`; PixiJS and the isometric scene are removed | Real geography, 3D buildings from OSM heights, GPU layers for 100k agents, keyless and offline | 04 §1–§3, MAP-01 to MAP-18 |
| D9 | **Georeference in the map bundle**: `MapBundle.geo` (centre, radius, cell size, projection id), filled at import; one `worldToMap` module using `METER_OFFSETS` with k = 0.998872 | Without it nothing lands on a basemap; the k factor removes 1.3 m drift | 04 §3, MAP-10 |
| D10 | Symbols: our own SVG set following ANSI INCITS 415 frames (incident diamond, operations circle, infrastructure rectangle), status by frame pattern and label; no MIL-STD-2525 | Familiar to US public safety; no third-party asset licence to manage | 04 §4, MAP-16 |
| D11 | **Uncertainty by seed ensembles**: Rehearse runs N seeds per plan (default 10) in browser workers; report-grade runs (≥50) in Node; cards show p10/p50/p90; ranking flags overlapping ranges; one ranking function feeds the verdict, the ranking and the card order | One seed is not evidence; the current verdict contradicts its own ranking | DOM-08, PER-01, PER-08, ENG-11 |
| D12 | **Metrics that discriminate**: smoothed density (R = 1 m), Fruin LoS area × time, time above thresholds per zone, egress percentiles (50/90/95/100%) per stand, queue exposure outside screening, ambulance access; equal metrics shown greyed with "no difference"; the 5.4 p/m² model limit flagged | The capped peak density ties every plan | DOM-01 to DOM-07, PER-09, ENG-20 |
| D13 | **Alarms**: three priorities by consequence, phase-aware rules, raised only when a decision is needed, everything else to the log; alarm rate per run tracked | Today the screen cries "CRITICAL" before kickoff with no incident | UI-04 to UI-06, PER-10 |
| D14 | **Video**: an on-device vision worker (onnxruntime-web, WebGPU then WASM) running DM-Count density maps; homography calibration from clicked point pairs with head-plane correction; outputs `ZoneObservation` aggregates on ≥2 m cells; observation tape; weights fetched by script with a pinned hash and run in a labelled demo licence mode | The only permissive, exportable density model; research-only training data needs retraining for production | 03 summary, VID-01 to VID-30 |
| D15 | **Platform**: one server (Hono + `node:sqlite` + `ws`); local accounts and sessions now with OIDC/SAML interfaces ready; RBAC by ICS position per event; hash-chained append-only audit log; event log with WebSocket fan-out and replay since `seq`; versioned scenarios and plans (draft, reviewed, approved = immutable); outbound allowlist; NWS feed; exports | Agencies judge the platform as much as the engine; the current server fetches any URL and has no accounts or audit | 06 §2–§9, PLT-01 to PLT-50 |
| D16 | **Products**: ICS 201/202/203/204/205/206/208/214 and an Event Action Plan, HSEEP ExPlan/MSEL/EEG/AAR-IP, situation report, GeoJSON/KML, CAP 1.2 drafts marked Exercise or Draft and never sent; a simulation annex (assumptions, seed, tape hash, versions) on every product; PDF through print CSS | Commanders brief and file in these formats | DOM-17 to DOM-20, DOM-28, PLT-33 to PLT-37 |
| D17 | **Design system**: a Hallmark redesign (custom direction: utilitarian, technical, austere; ISA-101 grey-is-normal), self-hosted fonts, tokens for day, night and wall themes, WCAG 2.2 AA; demo-only UI removed from operating builds and kept behind `?demo=1` | The current UI is a game-like cluttered rail | 04 Part B, UI-01 to UI-24, PER-24 to PER-27 |
| D18 | Units: US customary in the UI (°F, mph, ft, mi), crowd density in people/m² with the Fruin LoS letter, 24-hour local time (America/New_York) beside the game clock | A US police audience; Fruin and the Green Guide work in p/m² | PER-20, D-30 |
| D19 | Simulated people have no personal names or per-person traits on screen; a click on the crowd explains the decision groups present at that place (situation, odds, source) | The no-identities rule, and GOAL's "why that group moved" | MAP-14, PER-28 |
| D20 | Contract governance: `contracts.ts` changes are additive and optional unless the integration lead agrees; each workstream edits only its section (§5); `CONTRACT_VERSION` becomes `gameday.v4` when per-person frames become the default | Parallel workstreams must merge cleanly | — |

## 5. Shared interfaces

These are the seams between workstreams. Changing one needs the integration lead.

1. **`MapBundle.geo`** (in `contracts.ts`, done in wave 0): `{ center: { lat, lon }, radiusM, cellSizeM, projection: 'local-equirectangular' }`. World metres run from the grid's north-west corner, x east, y south; `lng = lon0 + (x − radiusM) / (111320 · cos lat0)`, `lat = lat0 − (y − radiusM) / 111320`. Maps without `geo` (the test map, old imports) render on a plain metre canvas.
2. **`SimConfig` engine selection** (WS1 owns this section of `contracts.ts`): optional `engine?: 'ts' | 'wasm'` and `fansPerAgent?: number` (default 5 for `'ts'`, 1 for `'wasm'`). Frames keep the `TickFrame` shape; arrays simply get longer.
3. **`Scorecard` extensions** (WS4 owns this section): optional fields only, plus an `ensemble` summary type kept in `world/src/metrics/`.
4. **`OpsMapProps`** (WS2 owns `map/src/types.ts`; WS6 consumes it). At minimum: the map bundle; 1–3 run views (label, latest and previous frame, scene, interpolation alpha); layout `single | compare | swipe | difference`; camera `2d | 3d`; theme `day | night | wall`; layer toggles; highlighted LoS band; hotspots per run; camera footprints and observations from vision; a focus box with a nonce; an armed pick tool; `onPick(MapPick)` where `MapPick` is one of cell or zone (with stats and the decision groups present), gate, vehicle, officer, closure or marker; `onViewChange`. It must also accept today's `FocusBox` in cells.
5. **`ZoneObservation`** (WS5 owns `vision/src/types.ts`): the message in 03 §"Recommended pipeline", `v: 'gameday.obs.1'`, with p10/p50/p90 bands, coverage, quality and provenance. Phase 1 also emits today's `Conditions` JSON.
6. **Platform API** (WS3 owns `docs/v3/api.md` and `app/src/platform/client.ts`): REST under `/api/v3` and a WebSocket at `/api/v3/events`. The event envelope is `{ seq, id, stream, type, actor: { userId, position }, serverTime, clientTime, simTime?, mode: 'plan'|'rehearse'|'exercise'|'live', payload }`. Existing `/api/*` routes keep working.
7. **Provenance tag** (WS4 owns `app/src/analysis/provenance.ts`; everyone uses it): `{ kind: 'simulated'|'estimated'|'forecast'|'assumed'|'default'|'observed', source, asOf, range? }`.

## 6. Workstreams

Each runs in its own git worktree under `/projects/sandbox/wt/<name>` on branch `feat/v3-<name>`, branched from `feat/v3-platform`. A workstream edits only the paths it owns; anything else goes in its `HANDOFF.md` as a request to the integration lead. Every commit keeps `npm run typecheck` and `npx vitest run` green.

| WS | Name | Owns | Wave |
| --- | --- | --- | --- |
| WS1 | Engine (Rust/WASM) | `engine-rs/**`, `engine/src/wasm/**`, `engine/src/movement-wasm.ts`, `engine/src/traffic-wasm.ts`, `engine/wasm/**`, `scripts/build-engine.mjs`, the engine-selection lines in `engine/src/worker.ts` and `engine/src/sim.ts`, the `SimConfig` section of `contracts.ts`; later `world/src/osm/fetch.ts` and the road part of `world/src/osm/stadium.ts` for the lane graph | 1, 2 |
| WS2 | Map | `map/**` (new workspace `@gameday/map`) | 1 |
| WS3 | Platform | `server/**`, `api/**`, `app/src/platform/**`, `docs/v3/api.md`, `vercel.json`, `.env.example` | 1 |
| WS4 | Analysis & correctness | `world/src/scoring.ts`, `world/src/metrics/**`, `app/src/story.ts`, `app/src/useRun.ts`, `app/src/analysis/**`, the `Scorecard` section of `contracts.ts`, minimal wiring in today's `app/src/App.tsx` | 1b |
| WS5 | Vision | `vision/**` (new workspace `@gameday/vision`) | 1b |
| WS6 | UI shell (Hallmark redesign) | `app/src/shell/**`, `app/src/field/**`, `app/src/styles/**`, `app/public/**`, `app/index.html`; `app/src/main.tsx` at integration | 1b |
| WS7 | Ops model & exercise | `world/src/venue/**`, `world/src/agencies.ts`, `world/src/exercise/**`, `world/src/incidents.ts`, `world/src/playbook.ts`, `world/src/weather.ts` | 2 |
| WS8 | Integration & QA | merges, `main.tsx` switch, `scripts/audit/**`, persona re-test, `README.md`, `CLAUDE.md`, `docs/v3/**` | every wave |

### WS1 Engine: deliverables and acceptance

- Phase 1: `engine-rs` crate (core clock and RNG streams, structure-of-arrays state, radix-sorted spatial hash, Dial fields reproducing today's integer distances, CSM with groups, multi-lane gate servers, arrivals, admission to seat, leaving, shelter, late rush, release, metrics), C-ABI exports, the TS host for browser workers and Node, `WasmMovement`, checkpoint and restore, determinism hashes.
- Phase 2: lane graph from OSM tags and nodes, IDM + MOBIL, junction controllers including officer traffic control points, contraflow, parking aisles, `WasmTraffic`.
- Acceptance: Rust V&V tests for RiMEA 1, 4, 6, 9, 11, 12a–d and IMO 4, 8 (02 §3) pass in `cargo test`; native and wasm state hashes match; the existing ingress, exit, game-end, orders, replay and rewind tests pass with `engine: 'wasm'` (tolerances recorded in `engine/wasm/PARITY.md` where per-person physics changes numbers); 100k agents plus traffic at ≥10× real time per plan, measured in Node and in headless Chromium with three workers.

### WS2 Map

- `OpsMap` per §5.4, the `worldToMap` module (corner error ≤0.1 m tested), day/night/wall styles, the shipped `osu.pmtiles` with local glyphs and sprites and its ODbL attribution, density as a LoS-stepped CVD-safe bitmap, agents from binary attributes with timeline-driven GPU interpolation, vehicles as oriented boxes in 3D and arrows in 2D, officers and units, closures and barricades, gates and zones, hotspots, routes, camera footprints, buildings extruded only where OSM has a height, the stadium bowl, compare (three synced maps), swipe and difference.
- A standalone demo page fed by recorded frames, checked by screenshots in headless Chromium.
- Acceptance: renders the Ohio map offline (no network); 3 × 100k agents and 5k vehicles stay interactive in SwiftShader (frame time recorded, the real-GPU budget is MAP-18); picking returns the §5.4 types; keyboard focus and a text alternative exist; no PixiJS import in `map/`.

### WS3 Platform

- Accounts, sessions, ICS-position roles per event, the audit log with chain verification, the event log and WebSocket hub, versioned scenarios and plans with the approval workflow, an outbound allowlist replacing `/api/conditions/fetch`, an NWS adapter with caching and provenance, exports (ICS forms, EAP bundle, simulation annex, sitrep, GeoJSON, KML, CAP draft) as print-ready HTML and data files, `docs/v3/api.md`, and the client in `app/src/platform/`.
- Acceptance: tests for every route, permission and chain-tamper case; the server still starts with zero configuration; the Vercel demo mode still builds.

### WS4 Analysis & correctness

- One ranking source with tolerance and ties (fixes D-01, D-02); the D12 metrics in scoring; ensembles with p10/p50/p90 and overlap flags; a bounded frame store (fixes the out-of-memory D-11, D-12); branching instead of destructive "play on" (D-13); scenarios that start near their incident (PER-05); one phase-aware alert level (D-04, D-05); the provenance helper.
- Acceptance: every incident, including the suspicious package, completes in the audit harness with flat memory; the verdict, the ranking and the cards always agree (property test).

### WS5 Vision

- File, webcam, HLS and WHEP sources; the vision worker with onnxruntime-web; the model fetch script with pinned SHA-256 and the demo licence mode; calibration (homography, head plane, residual in metres); projection to cells and zones; fusion across cameras; counting lines, queues, health; `ZoneObservation` and the observation tape; the `Conditions` emitter; privacy enforcement tests; a synthetic-video harness rendered from the simulation with exact truth.
- Acceptance: on synthetic video with known truth, zone NAE and band coverage are reported (VID-27, VID-28 targets recorded as measured or not met); a banned-API test proves no pixels are persisted; React components for calibration and the camera registry exist for WS6 to place.

### WS6 UI shell

- The Hallmark redesign as an app screen: top bar (clock and phase, incident, weather, mode, plan selector, provenance badge), left status board (alarms, sectors and gates, units), right inspector, bottom timeline with forecast lane, command palette, the comparison table, the LoS legend once, alarms in `aria-live`; the Field route for officers; the modes of §1; plain-language copy; self-hosted fonts; demo UI behind `?demo=1`.
- Acceptance: Hallmark `sloplint --scope app` clean or waived on the record; axe-core clean on the main screens; keyboard pass; 390 px Field route without overflow; the persona audit harness passes on the new shell.

### WS7 Ops model & exercise (wave 2)

- A venue model (gates with their real names and lane counts, sections, portals, shelters with capacity, aid stations, secure-zone line) as sourced data plus an editor; agencies and resource types for Unified Command (OSU PD, Columbus Police, OSHP, Columbus Fire EMS, venue staff) with call signs; sectors and posts; incident authoring (type, place, time, severity, concurrency, injects); plan types for evacuate, shelter in place and relocate; the lightning policy timer; the HSEEP exercise model (objectives, MSEL, EEG, AAR/IP).

## 7. Waves and integration

| Wave | Runs in parallel | Merge order into `feat/v3-platform` |
| --- | --- | --- |
| 0 | Integration lead: research, this plan, `MapBundle.geo`, worktrees | — |
| 1 | WS1 phase 1, WS2, WS3 | WS3, WS2, WS1 |
| 1b | WS4, WS5, WS6 | WS4, WS5, WS6 |
| 2 | WS1 phase 2, WS7, WS6 integration (OpsMap, platform client, analysis hooks into the shell) | WS7, WS1, WS6 |
| 3 | WS8: switch `main.tsx` to the shell, remove PixiJS and the old rail, flip the engine default after parity sign-off, persona re-test with the audit harness, docs, PR | — |

Integration protocol: merge with `--no-ff`; after each merge run `npm install`, `npm run typecheck`, `npx vitest run`, `cargo test` in `engine-rs`, then the audit harness `quick` group. Push `feat/v3-platform` after every green merge. Every workstream keeps its status in `docs/v3/handoff/<WS-id>-<name>.md` (state, what passes, how to run it, what is next, known issues, requests) and its licences in `docs/licences/<WS-id>.md`; per-workstream files keep merges conflict-free. A workstream that cannot finish leaves that file current and a continuation agent picks up from it.

## 8. Traceability

| Gap from the audit | Closed by |
| --- | --- |
| Verdict contradicts ranking; ties called "best" (PER-01, D-01, D-02) | WS4 |
| Package scenario out of memory (PER-02, PER-05, D-11) | WS4 |
| No screening model, wrong gate names (PER-03) | WS1 (lanes), WS7 (venue data) |
| No video or sensor input (PER-04) | WS5, WS6 (placement), WS2 (camera layer) |
| Plans lost on reload; destructive "play on" (PER-06, PER-07) | WS3 (persistence), WS4 (branching) |
| One seed; non-discriminating metrics (PER-08, PER-09) | WS4, WS1 (ensembles in Node) |
| Alarm fatigue (PER-10) | WS4 (levels), WS6 (alarm UI) |
| Incident authoring, ICS model, places, requests board (PER-11 to PER-15) | WS7, WS6 |
| Officer phone console and permissions (PER-16, PER-17) | WS6 (Field route), WS3 (RBAC) |
| Traffic ops, EMS, weather ops, alerting (PER-18 to PER-20, PER-29) | WS1 phase 2, WS7, WS3 (CAP drafts) |
| Exercise toolkit, exports, activity log (PER-21 to PER-23) | WS7, WS3 |
| Professional map, declutter, language, accessibility, no names (PER-24 to PER-28) | WS2, WS6 |
| Shared read-only view, venue model, deployment hygiene, import resilience, wider area (PER-30 to PER-34) | WS3, WS7, WS6, WS2 |
| Engine realism and V&V (ENG-01 to ENG-27, DOM-10 to DOM-12) | WS1 |

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Per-person physics changes calibrated numbers (gate quotas, clearance times) | Adapter migration behind `SimConfig.engine`; parity file with tolerances; keep the TS engine until sign-off |
| 100k agents in TS orchestration (decisions, density, officer instructions) costs more than the wasm step | Move density and decision grouping into wasm when profiling says so; columnar decision records |
| Parallel workstreams conflict in shared files | Ownership table (§6), additive contract edits, one integration lead, `--no-ff` merges in a fixed order |
| WebGL2 and MapLibre under SwiftShader are slow, so headless checks under-report frame rate | Record frame times only for comparison; the real-GPU budget is verified on the command-post machine |
| Density model weights are trained on research-only data | Demo licence mode, labelled; retraining or a licence before production (VID-12) |
| Sub-agent throttling or context exhaustion | Small commits, `HANDOFF.md`, continuation agents |

## 10. Definition of done for v3

1. All six modes and the Field route work end to end on the Ohio Stadium map, offline, in Chrome.
2. Every incident (lightning, gate surge, suspicious package, game end, plus an authored one) runs to completion with three plans and an ensemble, with flat memory.
3. The Rust engine is the default after parity sign-off; V&V and determinism suites pass in CI; ≥10× real time per plan with three plans and traffic.
4. Video from a file or webcam produces calibrated zone estimates with ranges on the map, with privacy tests passing.
5. Accounts, roles, the audit log, the shared event log and the exports work; the Vercel demo is still labelled synthetic.
6. The persona audit, re-run on the new build, closes every blocker and records what remains.
7. `npm run typecheck`, `npx vitest run`, `cargo test` and the audit harness `all` group are green; `README.md`, `CLAUDE.md` and `docs/licences.md` describe the new system.
