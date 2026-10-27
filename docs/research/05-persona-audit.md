# 05 — Persona audit: Gameday Command against a real game day at Ohio Stadium

Ten public-safety personas tried to do their real game-day jobs in the current app (branch `feat/v3-platform`), driven by a scripted headless browser. Every claim below points to an artifact.

**Bottom line.** The engine produces a plausible same-seed, three-plan comparison in two minutes, and the police order loop (suggest → dispatch → log → undo) works. But the commander-facing answer is not trustworthy yet: in two of the three incidents that finished, the verdict names a different "fastest" plan than the ranking directly below it. The suspicious-package scenario runs the page out of memory before the incident even starts. The gate model has no screening lanes. There is no video input. On a phone, the officer screen does not fit and carries the simulation controls. Nobody in Unified Command would brief from this today. A single training officer could use it for a desk exercise, with caveats.

Paths: `audit/…` means `/projects/sandbox/.kiro/artifacts/audit/…`; `shots/x` means `/projects/sandbox/.kiro/artifacts/screenshots/audit-x.jpg`.

## 1. Method

**Harness.** `scripts/audit/walkthrough.mjs` (usage in `scripts/audit/README.md`) starts the API server and Vite and drives headless Chromium through named flows. It writes page text, an aria snapshot and simulation state after every step, plus `summary.json` per flow and a merged `audit/index.json`. It then stops both children. In this session it was fixed before evidence collection:

- The ranking step used `.ranking select`, which also matched the feedback form's select (strict-mode error). It now uses `.ranking label.priority select`.
- A parent-death watchdog is preloaded into both children (`node --import`). It kills the child's process group if the harness dies, even by SIGKILL. Verified with a throwaway parent that was SIGKILLed: its child and grandchild were gone within 3 s. Shutdown also has a hard 20 s exit, and a port check confirms 8787 and 5173 are free.
- `--max-minutes` gives each call a budget: flows that no longer fit are skipped and a flow cut short is marked `cut-off`. The index is now written after every flow, so a run that is cut off keeps what it finished.
- Out-of-memory, stall and blank-app detection, so a dying page no longer burns its full time box on 15 s locator timeouts.
- A phone tap helper that records the hit test, an overflow probe, and a plan-editor regex fix (step text spans lines).

**Commands.** After `source /projects/sandbox/.kiro/env.sh`, five calls of `node scripts/audit/walkthrough.mjs`, so selectors could be fixed in between:

1. `inspectors police --max-minutes=14`
2. `officer plan-editor --max-minutes=16`
3. `officer plan-editor incident-surge --max-minutes=20`
4. `officer --max-minutes=8`
5. `incident-lightning incident-game-end --timebox=420 --max-minutes=14`

Total browser time was about 17 minutes. 43 JPEG screenshots are on disk (cap 45).

**Environment.** Node 22.23.4; Chromium 151 headless; playwright-core 1.62. WebGL 2 through SwiftShader (CPU). Desktop viewport 1440×900. Phone viewport 390×844 at DPR 2 with touch and mobile emulation. The database is isolated per call. Kev (port 8009) was down, so decisions came from the 737 cached answers plus the defaults table. Something answered on port 8080 but it was not Apple `fm serve`, so every briefing is the template (`audit/index.json` → `environment`).

**Flows on record** (`audit/index.json`):

| Flow | When | Status | Time | What failed |
| --- | --- | --- | --- | --- |
| start | earlier session | check-failed | 237 s | Stadium import gave up after 233 s: all three Overpass mirrors failed |
| views | earlier | ok | 97 s | — |
| tabs | earlier | ok | 81 s | — |
| keyboard | earlier | check-failed | 46 s | Rail tabs are not ARIA tabs (no arrow keys, no tabpanel) |
| incident-surge | re-run now | check-failed | 117 s | Finished results are lost on "Play on from here" |
| incident-lightning | re-run now | ok | 148 s | Checks pass; the verdict contradicts the ranking (content finding) |
| incident-game-end | new | ok | 94 s | Same verdict contradiction |
| incident-package | earlier | error | 428 s | Page out of memory at t = 12,135 s, then a blank app |
| plan-editor | re-run now | check-failed | 86 s | Edits lost on page reload |
| inspectors | new | ok | 63 s | — |
| police | new | ok | 111 s | — |
| officer | new | check-failed | 95 s | Page is 506 px wide on a 390 px phone |

**Could not be exercised headless, or only partly:**

- Real-GPU frame rate. SwiftShader gave 3.2 fps in 3D, 2.4 fps in the 2D plan and 1.3 fps in All three (`audit/views/summary.json`). Use these only to compare views.
- Live Kev decisions and the on-device AI briefing.
- Importing a new stadium. The public Overpass API was failing.
- Suspicious package. It was not re-run: the out-of-memory failure is deterministic and costs 7 minutes per try.
- Real touch on the phone. The page overflow shifts touch coordinates (aimed at y = 220, landed at y = 472), so taps fell back to DOM clicks and the map report to synthetic pointer events. Both are recorded in `audit/officer/summary.json`.
- Printing. `print()` was stubbed; the report HTML was saved instead.
- Multi-seat play. "Switch role" changes the role inside one tab.
- Video. The app has no video input at all.

**Severity.**

- **Blocker:** the persona cannot do a core job, or the tool's output would mislead them.
- **Major:** the job is possible but slow, risky or untrustworthy.
- **Minor:** polish.

Personas were played in character against a home game at Ohio Stadium: capacity 102,780 ([OSU Athletics](http://www.ohiostatebuckeyes.com/sports/2023/7/6/ohio-stadium)). It is a no-bag venue with walk-through metal detectors and hand wands ([event policies](https://ohiostatebuckeyes.com/sports/2018/8/1/ohio-stadium-event-policies), [screening](https://ohiostatebuckeyes.com/sports/2023/6/1/tests)). Game days are multi-agency ([Athletic Business](https://www.athleticbusiness.com/operations/safety-security/news/15148417/complex-security-at-ohio-state-michigan-game)).

## 2. Findings by persona

### P1 — Incident / Event Commander (OSU PD captain in Unified Command)

**Jobs to be done.**

- Before game day: choose among response options for the top threats and brief Unified Command partners on the tradeoffs.
- During the game: hold one picture, decide fast, and record why.

**Tasks tried.** Ran the gate surge, lightning, game end and suspicious package to completion. Read the verdict, the ranking (all four priorities), the plan cards, the Brief and About. Used All three, the replay, and "Play on from here".

**What happened.**

- **The verdict contradicts the ranking.**
  - Lightning: the verdict says Plan B "cleared the crowd at Stands fastest, in 13.2 min … Others: C 12.6 min, A 12.3 min". The ranking on the same screen says Plan A is fastest at 12.3 min (`audit/incident-lightning/summary.json` steps 04 and 06; `shots/incident-lightning-04-plans-verdict`).
  - Game end: the verdict says Plan A is fastest "in 27.0 min … Others: B 26.7 min, C 26.4 min". The ranking says Plan C at 26.4 min (`shots/incident-game-end-04-plans-verdict`).
  - Cause: `verdictText` in `app/src/story.ts` orders plans by danger-minutes (`rankPlans`) and then writes "fastest". The surge only agreed by coincidence.
- **"Best" is declared on ties.**
  - Surge, "Keep the ambulance route open": the ambulance is on scene in 4.3 min under every plan, yet the ranking says "Best … Plan C" (`audit/incident-surge/summary.json` step 05).
  - Peak density is 5.0 /m² for every plan in every incident. It is a cap and carries no information (`metrics.scorecards` in each incident summary).
  - Vehicle delay in the surge is 4,098.9, 4,098.9 and 4,099.4 vehicle-min.
- **The suspicious package never reaches the incident.**
  - Heap grew linearly from 340 MB to 8,759 MB.
  - At t = 12,135 s, 7.8 min before the package, the runs stopped with "Array buffer allocation failed". A canvas out-of-memory error then unmounted React and left a blank page (`audit/incident-package/summary.json` → `pageErrors`). Plan C's map is already black in `shots/incident-package-05-plans-cards`.
- **One seed** ("Random seed 20251023, the same for all three", About tab). The 36-second spread between egress plans (26.4–27.0 min) is presented as a ranking, with no sense of noise.

**What worked.**

- Three plans on the same crowd run to completion; each incident flow, UI steps included, took 94–148 s at 60×.
- Ranking by priority ends with "Your call." and never phrases output as an order.
- Plan cards show time to clear, first officer on scene, officer minutes, ambulance and alert reach (`shots/incident-surge-04-plans-cards`).
- The replay scrubber works.
- "Build three plans from this" produced three sensible plans from live conditions (`audit/tabs/summary.json` step 10).

**Friction.**

- The answer is split across the verdict, "Full numbers", the ranking, the cards and About.
- The weighted-danger figure is unitless, with false precision ("B 124960.3").
- A template disclaimer sits on top of every verdict.
- There are only four fixed situations; the incident's place and time cannot be set.

**Missing.**

- Incident authoring: type, place, time, severity, concurrent incidents.
- Uncertainty across seeds.
- A one-page Unified Command brief in the shape of an [ICS 201](https://training.fema.gov/emiweb/is/icsresource/assets/ics%20forms/ics%20form%20201,%20incident%20briefing%20%28v3%29.pdf): situation, objectives, resources, map.
- Partner agencies. A real game day has OSU PD, Columbus Police, the Highway Patrol, the Sheriff and federal partners ([Athletic Business](https://www.athleticbusiness.com/operations/safety-security/news/15148417/complex-security-at-ohio-state-michigan-game)); the app has 24 units named "OSU PD n".
- A decision log with the reasoning behind each call.

**Severity: blocker.** The headline answer contradicts itself, and one of the three advertised incidents cannot run.

**Must / should / could.**

- Must: one ranking source, with ties shown; bounded memory; incident authoring.
- Should: a seed ensemble with ranges; an ICS 201 export; partner agencies.
- Could: an on-device briefing that quotes only checked numbers.

### P2 — Operations Section Chief / sector lieutenant

**Jobs to be done.** Turn intent into assignments. Keep units where the trouble is. Answer officer requests. Know every unit's status.

**Tasks tried.**

- During the surge, in the Orders tab: accepted a suggestion, barricaded a street, placed a medical marker, sent a PA alert, redirected between gates, closed the busiest gate (Gates tab), undid an order, exported the timeline and printed the after-action report.
- As supervisor on the phone: answered two officer requests.

**What happened.**

- **All 13 police steps passed** (`audit/police/summary.json`). Six suggestions appeared 4 min before kickoff.
- **No place in the log.** Accepting one logged "2 officers responding: 5,650 people packed, peak 5.0/m²; 41 vehicles stopped; seen for 0.0 min" (step 03).
- **Targets are unreadable.** "Send OSU PD 12 and OSU PD 15 to On Olentangy River Road"; another target is "590 m from Gate 9 (WSW)" (`shots/police-02-orders-tab-suggestions`).
- **Requests carry no location, priority or age.** The supervisor sees "OSU PD 5: medical, 12 min to kickoff" (`shots/officer-05-switch-to-supervisor-and-see-requests`). "Send nearest free unit" did dispatch OSU PD 2 (`audit/officer/summary.json` step 06).
- **The Orders tab is 8.2 screens tall**, with 73 controls, 18 headings and 1,032 words (`metrics.rail-orders`).
- **Bulk dispatch has no confirmation.** "Dispatch suggested units" sends all six at once with no preview.

**What worked.**

- A real loop: suggestion with walking ETA and return time → dispatch → roster with ETA and "spoken to / did as told" counts (`shots/police-10-order-log`).
- Undo sends the inverse order.
- Officer request → supervisor → nearest free unit.

**Friction.**

- Fifteen functions live in one scroll.
- Orders reach only the plan on the map.
- "0.2% of outdoor walkable area within reach" is not an operational number.
- The roster table is clipped at the right edge ("Fol…").

**Missing.**

- Named sectors and posts with assigned units.
- Unit types (foot, bike, mounted, motor, K9, bomb squad), call signs, and a radio plan ([ICS 205](https://training.fema.gov/emiweb/is/icsresource/assets/ics%20forms/ics%20form%20205,%20incident%20radio%20communications%20plan%20%28v3.1%29.pdf)).
- A status board: unit, status, since when, where.
- A request queue with place, priority and age.
- Staging areas with counts.

**Severity: major.**

**Must / should / could.**

- Must: readable places; requests with place and priority; Orders split into task panes; confirm bulk dispatch.
- Should: sectors and unit types; a status board.
- Could: a radio channel plan.

### P3 — Traffic Unit Sergeant

**Jobs to be done.** Fill the lots before kickoff and empty them afterwards. Run the planned closures, such as Woody Hayes Drive between Cannon Drive and Tuttle Park Place ([Dayton Daily News](https://www.daytondailynews.com/sports/what-to-know-about-ohio-state-game-day-traffic-parking-and-other-tips/article_0a8256a5-d46b-5983-a93b-00e8edff0b00.html)). Staff the traffic control points. Keep an emergency lane open.

**Tasks tried.**

- Watched road colouring and vehicle counts in 2D and 3D.
- Clicked a vehicle.
- Barricaded a street.
- Read the stopped-vehicle hotspots and the lot board.
- Ran the full game-end egress.

**What happened.**

- **One click closes an arterial, with no preview.** A single click on a road put up "Olentangy River Road (all blocked)". The barricade type select was on its default, "Vehicles only" (`audit/police/summary.json` step 04, list in `shots/police-05-place-a-medical-marker`). No affected-vehicle or detour preview.
- **Egress runs, but the plans hardly differ.** Game end: 3,272–3,274 vehicles drove off in 60 min, and vehicle delay was 2,747–2,862 vehicle-min across plans (`audit/incident-game-end/summary.json` → scorecards).
- **The traffic model covers only surface lots.** The app says so itself: "3,281 vehicles for 3,860 mapped surface parking stalls. Buildings and off-map parking are not counted" (transport row, every desktop screenshot).
- **Crowd plans do not change traffic.** In the surge, traffic results were identical across plans (vehicle delay 4,098.9 vs 4,098.9 vs 4,099.4).
- **The lot board measures crowd density, not cars.** "Lots · occupancy from the crowd grid: Lot 78 186%" (`audit/tabs/06-tab-gates.txt`).
- **The vehicle inspector is trivia.** Type, mph, time stopped, size, passengers (`shots/inspectors-03-click-a-vehicle`). It shows no lot, no exit and no time to get out.

**What worked.**

- Moving / Slow / Jammed road colouring.
- Moving, stopped and parked counts per plan.
- Stopped-vehicle hotspots ranked with crowd hotspots.
- Barricades offer "Move or resize" and "Remove".
- A traffic control point order exists.
- Ambulance travel time is on every scorecard.

**Friction.**

- The map covers only the stadium plus 0.5 mi; the after-action title even reads "Ohio Stadium + 0.5 mi". City detours fall off the edge.
- Speed is in mph, but barricade reach is in metres.
- "High — Olentangy River Road HIGH: 71 vehicles stopped" says High twice (`audit/tabs/03-tab-brief.txt`).

**Missing.**

- Closures on a schedule.
- One-way and contraflow conversions. Roads near the stadium turn one-way on game day (Dayton Daily News).
- Ramp closures. The SR-315 exit ramp to Lane Avenue may close temporarily ([OSU Wexner Medical Center](http://medicalcenter.osu.edu/patient-and-visitor-guide/osu-game-day-parking)).
- Transit. CABS buses are suspended from six hours before kickoff until two hours after the game ([OSU TTM](https://ttm.osu.edu/football_saturdays)).
- Garages and rideshare zones.
- Clearance time per lot.
- Queue lengths at key intersections.

**Severity: major.**

**Must / should / could.**

- Must: preview and confirm closures; honour the barricade type; clearance time per lot; garages, or the missing share stated as a number.
- Should: closure schedules, one-way conversions, ramp closures, a traffic control point staffing plan.
- Could: transit and shuttles; a wider map.

### P4 — Gate & Perimeter Supervisor

**Jobs to be done.**

- Open on time and run screening at the rate the crowd needs. Ohio Stadium is no-bag, and everyone passes a walk-through metal detector or a hand wand ([OSU event policies](https://ohiostatebuckeyes.com/sports/2018/8/1/ohio-stadium-event-policies), [OSU screening](https://ohiostatebuckeyes.com/sports/2023/6/1/tests)).
- Absorb the kickoff surge: redirect, close and reopen gates.
- Hold the perimeter and the secure zone.

**Tasks tried.**

- Ran the gate surge.
- Closed the busiest gate.
- Redirected Gate 1 to Gate 4.
- Sent a PA alert naming open gates.
- Built three plans from current conditions.
- Read the zone and lot boards.

**What happened.**

- **The gate table contradicts the rest of the screen.** Eight minutes before kickoff: 11 gates open, 505 people/min in total, and "Waiting 0" at every gate (`shots/tabs-06-tab-gates`). At the same moment the plan card says "Dangerously packed 18,725" (`shots/tabs-05-tab-plans`) and the Brief lists "590 m from Gate 9 (WSW) … CRITICAL" (`audit/tabs/03-tab-brief.txt`).
- **The "surge" gate is barely queuing.** Gate 2 had 30 people waiting four minutes before kickoff.
- **Closing a gate works.** Its queue moved, and Gate 1 rose to 85 waiting (`audit/police/summary.json` step 08).
- **The gate names will not match the radio.** The app has Gates 1–12 with compass letters and no Gate 8. Official guidance refers to an accessible shuttle at Gate 22/26 ([OSU](https://ohiostatebuckeyes.com/sports/2026/4/6/concert-parking)), and to medical and childcare bag entrances by Gate 10 and the Press Entrance by Gate 23 ([Desert Sun, 2023](https://www.desertsun.com/story/sports/college/football/2023/09/05/ohio-stadium-bag-policy-what-osu-football-fans-can-bring-to-home-games/70760322007/)).
- **Unexplained board metrics.** The zone board says "time to 4 p/m²: now" for parking lots holding a few hundred people (`audit/tabs/06-tab-gates.txt`).

**What worked.**

- Open and close per gate, with live in/out per minute and a utilisation bar.
- Redirect is logged.
- The surge plans really differ in time to clear: 10.3, 11.6 and 20.6 min (`shots/incident-surge-04-plans-cards`).

**Friction.**

- A green "Open" badge sits next to a "Close" button and reads like two states.
- Queues are shown as head counts, not minutes.
- Only one plan's gates are on screen at a time.

**Missing — the core of this job.**

- Screening lanes per gate, with throughput per lane for metal detectors and wands.
- Staff per lane and the share sent to secondary screening.
- Bag rejects walking back to cars.
- Express entry and ticket-scan failures. OSU expanded express entry for 2026 ([ABC6](https://abc6onyourside.com/news/local/heading-to-the-shoe-what-ohio-state-fans-need-to-know-for-the-2026-season)).
- Accessible and medical-bag entrances.
- Queue capacity and layout.
- The secure zone and its vehicle-barrier line. OSU places concrete barriers to set secure zones with OSU PD and Homeland Security ([OSU FOD](https://fod.osu.edu/node/984)).

**Severity: blocker.** The decision this person makes, how many lanes to staff where, is not in the model.

**Must / should / could.**

- Must: a lane-level screening model; real gate names; wait time in minutes.
- Should: the perimeter and secure zone; special entrances; reject and re-entry flows.
- Could: ticket-scan failure rates.

### P5 — Patrol Officer in the field

**Jobs to be done.** Know my post and assignment. Acknowledge it. Get where I'm sent. Report what I see, with a location. Call for backup. All on a phone, in sunlight, wearing gloves.

**Tasks tried.** At 390×844 with touch:

- Demo sign-in as Officer, unit OSU PD 5.
- Ran to 15 min before kickoff.
- Acknowledge, Need backup, and a medical report placed on the map.
- Read nearby routes.
- Switched to Supervisor to see the other side.

**What happened.**

- **The page does not fit the phone.** It lays out 506 px wide. The culprits are the 492 px header block ("… 1 dot = 5 fans, 20,000 dots, 100,000 fans") and an incident label (`audit/officer/summary.json` → `metrics.phone-fit`). The sign-in card and the header are cut off on the right (`shots/officer-01-demo-sign-in-as-officer`, `shots/officer-02-choose-unit-and-enter`).
- **The officer gets the whole simulation bar above the map.** Scenario buttons, "Run all three plans", 5×/20×/60×, weather, vehicles, coverage, Restart and the synthetic-data banner (step 02: `transportVisible: true, situationsVisible: true`). An officer can switch the scenario or restart the run for everyone.
- **Officers cannot report their own status.** The console shows "Demo sign-in, no account needed … Awaiting assignment at your original post", then Acknowledge, En route and On scene. En route and On scene are disabled (`shots/officer-03-run-acknowledge-and-ask-for-backup`).
- **Reports reach the supervisor.** Acknowledge and backup were logged. The medical report reached the supervisor as "OSU PD 5: medical, 12 min to kickoff", with no place name (step 05).
- **Post names disagree.** The unit picker lists all 24 units as "Outdoor post", while the map labels the same post "OSU PD post - Millikin Road" (`audit/officer/01-demo-sign-in-as-officer.txt`).
- **Text and targets are small.** 41 of 59 text elements are under 14 px, and 21 of 33 controls are under 44 px (`metrics.layout-officer-phone`).

**What worked.**

- Acknowledge goes into the log.
- Backup and location reports reach the supervisor, who can send the nearest free unit.
- "Nearby walking routes" gives minutes per gate.
- The map centres on the officer.

**Friction.**

- The map starts about 640 px down the page.
- The console sheet scrolls inside a page that also scrolls. Every automated tap was intercepted by another element (step 03 → `taps`). A map tap aimed at y = 220 arrived at y = 472 (step 04 → `touchEvents`), a side effect of the 506 px layout. Verify on a real device.

**Missing.**

- An assignment-first layout: one-tap status, a text or photo note on a report, navigation to the post.
- New assignments pushed to the officer.
- A high-contrast outdoor theme.
- Tolerance for a dropped connection.
- US units.

**Severity: major.**

**Must / should / could.**

- Must: fit 360–430 px; no simulation controls for officers; officer-set status; targets of 48 px or more.
- Should: an outdoor theme; a report confirmation that names the place.
- Could: an offline queue for reports.

### P6 — EMS / Fire liaison

**Jobs to be done.** Know where patients will come from. Keep EMS access routes and fire lanes open. Stage units. Size the medical response for a surge, lightning, heat or a package evacuation. Plan transport to hospitals.

**Tasks tried.**

- Placed a medical-tent marker.
- Had an officer report "medical".
- Compared "Ambulance on scene" across plans and ranked by "Keep the ambulance route open".
- Read a heat run (Early-season heat, 33 °C).

**What happened.**

- **The medical marker is just a label.** "Medical tent marker" text on the ground, with no symbol, capacity or effect (`shots/police-05-place-a-medical-marker`).
- **One ambulance per incident, and the plans tie.**
  - On scene in 4.25 min under all three surge plans; 2.7 / 2.95 / 2.7 min for lightning; 3.48 / 3.55 / 3.5 min at game end.
  - "Keep the ambulance route open" still names a winner each time (rank steps in the incident summaries).
- **Heat produces no medical output.** The scorecard has no heat-related field. Per the README, weather only changes walking and driving speed and the decision context.
- **Shelter has no destination.** The lightning plans say "Order everyone to shelter" (`audit/incident-lightning/05-plans-cards.txt`) but show no shelter locations or capacity. OSU's own guidance sends people outside the bowl to their cars, French Field House or St. John Arena ([OSU safety information](https://ohiostatebuckeyes.com/sports/2026/4/6/concert-emergency)).

**What worked.**

- An emergency-response time on every scorecard.
- A ranking priority for ambulance access.
- Officers' medical reports reach the supervisor.
- The density bands work as a crush-risk proxy, with the caveats in §4.

**Missing.**

- EMS resources: ALS and BLS units, carts, first-aid stations inside the stadium.
- Casualty estimates as ranges with stated assumptions (crush, heat, lightning).
- Patient flow to treatment points and hospitals. The medical center's own game-day page warns of ramp closures.
- Fire lanes and staging areas with their access routes.

**Severity: major.** It is a blocker for casualty planning.

**Must / should / could.**

- Must: an EMS layer (stations, units, access routes); an ambulance metric that reports ties.
- Should: casualty ranges; shelter places and capacity.
- Could: hospital load.

### P7 — Training & Exercise Officer (HSEEP tabletop)

**Jobs to be done.** Design a tabletop: objectives, scenario and injects. Run it with several players. Evaluate against the objectives. Write an After-Action Report / Improvement Plan (AAR/IP) recording strengths, areas for improvement and corrective actions ([FEMA HSEEP](https://www.fema.gov/emergency-managers/national-preparedness/exercises/hseep), [2020 doctrine](https://www.fema.gov/sites/default/files/2020-04/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2-25.pdf)).

**Tasks tried.**

- Edited a plan and added a phone alert; restarted; ran past the alert; reloaded the page.
- Replay, rewind ("Play on from here") and the feedback box.
- Exported the timeline as JSON and printed the after-action report.

**What happened.**

- **Plan edits do not survive a reload.** The edited plan ran and its phone alert fired: "reached 49,270 fans so far" (`audit/plan-editor/summary.json` step 04, `shots/plan-editor-04-run-edited-plans-past-the-alert`). After a reload the stock plan was back: "Send 6 officers to Gate 2 (NNE)" (step 05).
- **"Play on from here" silently deletes the finished comparison.** All three scorecards and the verdict are gone; it reads "Appears when all three plans finish." (`audit/incident-surge/summary.json` step 10).
- **The after-action report is not an AAR.** Its title is "After-action report: Ohio Stadium + 0.5 mi, plan A". It says "The run has not finished, so there is no scorecard yet", then shows a timeline (`audit/police/after-action.html`). It has no objectives, no strengths or areas for improvement, no corrective actions, and none of the feedback that was "kept with the run for the after-action review" (surge step 09).
- **The JSON export cannot reproduce the run.** It holds plan, map, scorecard and a 9-entry timeline, with no seed, plan definition, decision tape or version (`audit/police/timeline-export.json`).
- The package scenario cannot be exercised at all (P1). "Switch role" swaps roles inside one browser tab.

**What worked.**

- The determinism story: same seed, same decision tape, same run.
- Replay, the timeline export and the printable log.
- The feedback capture and the editable plans.
- Neutral, "your call" wording.

**Missing.**

- Exercise objectives and capabilities.
- A master scenario events list (MSEL) with timed injects.
- Controller and evaluator roles, with notes in the shape of [FEMA Exercise Evaluation Guides](https://preptoolkit.fema.gov/web/hseep-resources/eegs).
- An AAR/IP template.
- Saved exercise packages.
- Multi-seat play from separate devices.
- Branches compared side by side.

**Severity: major.** It is a blocker for the package scenario.

**Must / should / could.**

- Must: persistent plans and scenarios; branching that keeps the original; an AAR/IP export.
- Should: injects and a MSEL; evaluator notes; multi-seat play.
- Could: scoring against objectives.

### P8 — Real-Time Crime Center / video analyst

**Jobs to be done.** Watch the cameras. Turn video into counts, density and flow per zone, with no faces and no identities. Spot pressure building early. Hand the commander observed numbers with their uncertainty.

**Tasks tried.**

- Looked for any camera or video input.
- Used "Load real conditions (gate scans, traffic)".
- Clicked a fan.
- Compared the density bands and hotspot lists with what cameras would show.

**What happened.**

- **There is no camera, video or sensor input.** The only feed is "Load real conditions", JSON or CSV of gate queues and stopped vehicles; "Only what the feed reports is shown" (`audit/tabs/summary.json` step 09). The synthetic sensor model in `app/src/sensors.ts` is not wired (README, "Forecast layer").
- **Simulated groups carry personal names.** Clicking one shows "Dakota Brutus" with patience, compliance and mobility bars (`shots/inspectors-02-click-a-fan`). They are synthetic, but in a police tool this reads as tracking individuals. It undercuts the no-identities rule and sets the wrong expectation of what video analytics will deliver.
- **The model cries wolf.** Before kickoff, with no incident, 17,000–18,700 people sit in the "Danger 3.5+ /m²" band, and hotspots away from the gates, one of them a parking lot, are flagged "CRITICAL" (`shots/views-03-3d-dark`). An analyst checking cameras against that would stop trusting the colours.

**What worked.**

- A feed shows only what it reports.
- Data is labelled synthetic.
- Density bands can be isolated, with "where it is" lists and zoom (`audit/views/summary.json` step 09).

**Missing.**

- A camera registry on the map: field of view and zone polygons.
- Per-zone count, density and flow, with uncertainty, latency and coverage.
- Sensor health.
- Observed and simulated values side by side, with divergence alerts.
- No frames stored by default, and an audit of who viewed what.

**Severity: blocker.**

**Must / should / could.**

- Must: a zone-level observation layer with uncertainty; no personal names on simulated people.
- Should: sensor health; divergence alerts.
- Could: on-device video counting.

### P9 — Venue Operations / Event Security Director

**Jobs to be done.** Own the venue operations plan: gates, screening, stewards, concourses, PA and video boards, weather policy, evacuation or shelter, re-entry, accessible services. Work with police in Unified Command. Show due diligence.

**Tasks tried.**

- Everything P4 did.
- Weather scenarios and the lightning plans.
- PA alerts and "Release the crowd".
- The stadium chooser and an import.
- Light theme.

**What happened.**

- **Importing another venue failed after 233 s.** It showed raw upstream errors: "overpass-api.de 502; overpass.kumi.systems 504; … aborted due to timeout" (`audit/start/summary.json` step 04, `shots/start-04-import-first-hit`). For imported venues, gates "are placed evenly around the bowl" (start screen).
- **The bowl is one zone, "Stands".** The verdict reads "cleared the crowd at Stands". There are no sections, portals, concourse levels or numbered exits.
- **Lightning has no clock.**
  - Nothing shows the time since the last strike, although NWS says to wait 30 minutes after the last thunder before resuming ([NWS](https://www.weather.gov/safety/lightning-outdoors)).
  - The weather picker still reads "Clear, 12°C" while the map card says "Thunderstorm , lightning" (`shots/incident-lightning-02-run-to-5-min-after-incident`).
- **Release asks first.** "Release the crowd" asks "Everyone heads for the exits. Sure?" (`audit/police/summary.json` step 13). Good.
- **The 3D close-up looks like a toy.** Voxel stands, figurines and block cars (`shots/views-03-3d-dark`, `shots/inspectors-03-click-a-vehicle`). It would not survive a meeting with the athletics director.

**What worked.**

- Weather timelines: rain, thunderstorm, snow, fog, heat.
- PA and phone alerts with reach.
- Confirmation before release.
- Honest synthetic-data labelling.

**Missing.**

- A venue model: sections, portals, concourses, exits, ADA routes.
- Steward and contract-security staffing.
- A message library for the PA and video boards.
- A weather-policy timer.
- Shelter in place versus evacuation, with capacities.
- Re-entry rules.
- A gate and lane editor after import.

**Severity: major.** It is a blocker for screening (P4).

**Must / should / could.**

- Must: the venue model plus a gate and lane editor; a lightning timer; a professional map.
- Should: staffing; a message library; shelter-in-place options.
- Could: re-entry and credential zones.

### P10 — City Emergency Manager / EOC liaison

**Jobs to be done.** Know what the event means for the city: traffic beyond campus, hospitals, shelters, public alerts. Get situation reports. Broker resource requests. Keep the EOC's common operating picture current.

**Tasks tried.**

- Read the Brief, the verdicts and the exports.
- Checked the alert controls and the weather.
- Checked the map extent.
- Checked sign-in and security.

**What happened.**

- **The city is off the map.** It covers the stadium plus 0.5 mi, so impacts beyond that are invisible.
- **Nothing to share with the EOC.** Exports are a JSON timeline and a print page. There is no situation report, no map export and no shareable view.
- **Alert reach is a typed percentage.** "Phone alert aimed at 50% of fans in range". The message box has no length limit or template (`shots/plan-editor-02-edit-a-step-and-add-a-step`). WEA requires a 90-character message with an optional 360-character one ([FEMA IPAWS best practices](https://www.fema.gov/emergency-managers/practitioners/integrated-public-alert-warning-system/public-safety-officials/alerting-authorities/best-practices)).
- **No real access control.**
  - Sign-in is "Demo sign-in, no account needed", and role switching needs no authentication.
  - `app/index.html` loads fonts from Google's CDN. A locked-down or offline EOC loses them, and every load calls a third party.
- **No ICS paperwork.** No ICS 201 or ICS 214 style output ([FEMA ICS forms booklet](https://training.fema.gov/emiweb/is/icsresource/assets/nims%20ics%20forms%20booklet.v3.pdf)).

**What worked.**

- The timeline export.
- Clear synthetic labelling.
- Weather scenarios.
- A tool that shows tradeoffs and leaves the decision to people.

**Missing.**

- A read-only live view for partners.
- A situation-report export, plus GeoJSON or KML for the map.
- Alert drafting that knows IPAWS and WEA limits.
- A regional traffic layer.
- Hospitals and shelters.
- Integration hooks for CAD and WebEOC.
- Real authentication, an audit trail, data retention rules.

**Severity: major.**

**Must / should / could.**

- Must: a shareable read-only picture with a situation-report export; real authentication with an audit trail.
- Should: WEA-aware alert drafting; a regional layer.
- Could: CAD and WebEOC hooks.

## 3. Cross-persona gap matrix

**Key.** M = must, S = should, C = could, · = not this persona's need. The "Today" column says what the app has now.

| Capability | Today | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 | P9 | P10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| One consistent verdict and ranking, with ties shown | contradicts itself | M | S | S | S | · | S | M | · | M | S |
| Every incident runs; memory bounded; no blank page | package fails (out of memory) | M | M | M | M | S | M | M | S | M | M |
| Uncertainty ranges (seed ensemble) | one seed | M | S | S | S | · | S | M | M | S | S |
| Incident authoring and injects | 4 fixed situations | M | S | S | S | · | S | M | C | S | S |
| Saved, versioned plans and scenarios | lost on reload | M | M | S | S | · | S | M | · | M | S |
| Branching that keeps the original result | deletes it | S | C | C | C | · | C | M | · | C | C |
| ICS / Unified Command roles, partner agencies, ICS 201/214 outputs | none; 24 OSU PD units | M | M | S | S | C | M | M | C | S | M |
| Sectors, unit types, status board, readable places | roster and ETAs only | S | M | M | S | M | S | S | C | S | C |
| Gate screening: lanes, detectors, rejects, real gate names, wait minutes | aggregate throughput | S | S | · | M | C | C | S | S | M | C |
| Perimeter, secure zone, vehicle barriers | street barricades | S | S | M | M | C | S | S | C | M | S |
| Traffic: closure preview and schedules, one-way, ramps, garages, transit, lot clearance | road colouring, one-click closures | S | S | M | · | C | S | S | · | S | M |
| EMS / Fire: units, first aid, casualty ranges, access routes, hospitals | one ambulance | S | S | S | C | C | M | S | · | S | M |
| Weather: lightning timer, shelters with capacity, heat illness, US units | weather timelines | M | S | C | S | S | M | S | · | M | M |
| Public alerting: channels, templates, WEA 90/360 limits | typed reach % | S | C | C | S | · | C | S | · | M | M |
| Video / sensor observation layer with uncertainty, privacy-first | none | S | S | C | S | · | C | C | M | S | S |
| Officer phone console: fits, no simulation controls, self-status, push | overflows; shows simulation controls | C | S | C | C | M | C | S | · | C | · |
| Exercise toolkit: objectives, MSEL, evaluator notes, AAR/IP, multi-seat | log print and feedback box | S | C | C | C | C | S | M | C | S | S |
| Shareable read-only view, situation report, reproducible exports | JSON timeline | S | C | C | C | · | S | M | S | S | M |
| Professional map: 2D symbology; 3D without the game look; overlays that don't hide data | toy 3D; cluttered 2D | M | S | S | S | S | S | S | M | M | S |
| Accessibility and legibility (keyboard map, tabs, sizes, contrast) | partial | S | S | S | S | M | S | S | S | S | S |
| Authentication, roles, audit trail, offline, no CDN | demo sign-in | S | S | C | C | S | C | S | M | S | M |

Read across: the first two rows decide whether anyone can trust the output at all. Rows 7–15 are where the personas' real jobs live, and the app barely touches them. Rows 16–21 decide whether it looks and behaves like professional software.

## 4. UI/UX defects with evidence

### 4.1 Wrong or contradictory output

| ID | Defect | Evidence | Severity |
| --- | --- | --- | --- |
| D-01 | **Verdict names the wrong "fastest" plan.** Lightning: verdict B (13.2 min), ranking A (12.3 min). Game end: verdict A (27.0 min), ranking C (26.4 min). `verdictText` (`app/src/story.ts`) sorts by danger-minutes and writes "fastest". | `shots/incident-lightning-04-plans-verdict`, `shots/incident-game-end-04-plans-verdict`; steps 04 and 06 of both incident summaries | blocker |
| D-02 | **"Best" on a tie.** Ambulance 4.3 / 4.3 / 4.3 min → "Best … Plan C". Lightning ambulance 2.7 / 2.95 / 2.7 → "Plan C". | `audit/incident-surge/summary.json` step 05; lightning step 06 | major |
| D-03 | **Numbers that cannot discriminate shown as if they do.** Peak density 5.0 /m² for every plan in every incident (a cap). Surge vehicle delay 4,098.9 / 4,098.9 / 4,099.4 vehicle-min. 141 vehicles out under every plan. | `metrics.scorecards` in the incident summaries; `shots/incident-surge-04-plans-cards` | major |
| D-04 | **The Brief contradicts itself.** "All gates and streets are at low levels" sits directly above "Outside Gate 4 (E) 38,055 packed … CRITICAL". | `shots/incident-lightning-02-run-to-5-min-after-incident` | major |
| D-05 | **Alarm fatigue.** Before any incident: Danger band 17,700 people, "Dangerously packed 18,725", and two hotspots away from any gate ("590 m from Gate 9 (WSW)", "By Stadium Lot Northeast") flagged "CRITICAL" — while the Gates tab shows "Waiting 0" at all 11 gates. | `shots/views-03-3d-dark`, `shots/tabs-05-tab-plans`, `shots/tabs-06-tab-gates` | major |
| D-06 | **Barricade type ignored or mislabelled.** "Vehicles only" selected; the list says "Olentangy River Road (all blocked)". | `audit/police/summary.json` step 04; `shots/police-05-place-a-medical-marker` | major (verify which is true) |
| D-07 | **The clock disagrees with itself.** "8 min to kickoff — Gate surge starts in 9 min". | `shots/tabs-04-tab-orders` | minor |
| D-08 | **Lot occupancy over 100%.** "Lot 78 186%", measured from the crowd grid, not cars. | `audit/tabs/06-tab-gates.txt` | minor |
| D-09 | **Post names disagree.** All 24 units are "Outdoor post" in the picker; the map says "OSU PD post - Millikin Road". | `audit/officer/01-demo-sign-in-as-officer.txt`, `shots/officer-03-run-acknowledge-and-ask-for-backup` | minor |
| D-10 | **The weather picker lags the scene.** It shows "Clear, 12°C" during the thunderstorm; the card wraps as "Thunderstorm , lightning". | `shots/incident-lightning-02-run-to-5-min-after-incident` | minor |

### 4.2 Broken states and performance

| ID | Defect | Evidence | Severity |
| --- | --- | --- | --- |
| D-11 | **The suspicious package runs the page out of memory.** Heap climbs linearly from 340 MB to 8,759 MB (about 32 MB per simulated minute). "Array buffer allocation failed" at t = 12,135 s; then a canvas out-of-memory error with no error boundary, and a blank app. Cause: `useRun.ts` keeps every frame together with its full 640k-cell Float32 density grid (2.56 MB × 4 frames/min × 3 plans ≈ 31 MB/min). On top of that, `windowFor` starts this scenario 60 min before kickoff for an incident 210 min after it. | `audit/incident-package/summary.json` → `metrics.run-to-incident.samples`, `pageErrors`; `shots/incident-package-05-plans-cards` (plan C map black) | blocker |
| D-12 | **Even short runs need gigabytes.** Peak heap 3.3 GB (surge), 4.7 GB (lightning), 2.6 GB (game end); 2.1–2.3 GB at 20 min before kickoff. | `peakHeapMB` in the incident summaries; `audit/views/summary.json` | major |
| D-13 | **"Play on from here" deletes the result without asking.** Scorecards, verdict, briefing and saved comparison are cleared (`App.tsx` replay handler). | `audit/incident-surge/summary.json` step 10 | major |
| D-14 | **Plan edits are lost on reload.** Nothing is persisted. | `audit/plan-editor/summary.json` step 05 | major |
| D-15 | **Stadium import fails slowly.** It takes 233 s to give up, shows raw upstream errors, and offers no local-file import. | `audit/start/summary.json` step 04; `shots/start-04-import-first-hit` | minor |
| D-16 | **Main-thread load.** Worst frame 850 ms; 1.3–3.2 fps on SwiftShader. Unverified on a real GPU. | `audit/views/summary.json` → `fps-*` | minor until measured on a GPU |
| D-17 | **Asset hygiene.** Fonts come from Google's CDN, and `/favicon.ico` 404s on every load. | `app/index.html`; `console.json` in every flow | minor |

### 4.3 Phone and field use

| ID | Defect | Evidence | Severity |
| --- | --- | --- | --- |
| D-18 | **The page is 506 px wide on a 390 px phone.** The 492 px header block (the "1 dot = …" line does not wrap) and a map label push it out; the sign-in card and header are cut off. | `audit/officer/summary.json` → `metrics.phone-fit`; `shots/officer-01-demo-sign-in-as-officer`, `shots/officer-02-choose-unit-and-enter` | major |
| D-19 | **Officers get the simulation controls.** Scenario switch, run, speed, weather, Restart. They can change or restart the shared run. | step 02 `simControlsShownToOfficer`; `shots/officer-02-choose-unit-and-enter` | major |
| D-20 | **The map starts about 640 px down, and touch lands off target.** The console sheet scrolls inside a scrolling page. Every automated tap on the console was intercepted by another element, and a map tap aimed at y = 220 arrived at y = 472. Confirm on a device. | `shots/officer-02-choose-unit-and-enter`; steps 03 `taps` and 04 `touchEvents` | major |
| D-21 | **Officers cannot set their own status.** "En route" and "On scene" are disabled. | `shots/officer-03-run-acknowledge-and-ask-for-backup` | minor |
| D-22 | **Requests have no place, priority or age.** "OSU PD 5: medical, 12 min to kickoff". | `shots/officer-05-switch-to-supervisor-and-see-requests` | major |

### 4.4 Accessibility

**Passed:**

- 64 of 64 focused controls show a focus ring.
- No keyboard trap.
- The sign-in dialog cycles focus correctly.
- "Run all three plans" is the 9th Tab stop.

(`audit/keyboard/summary.json`, `audit/start/summary.json` step 01)

| ID | Defect | Evidence | Severity |
| --- | --- | --- | --- |
| D-23 | **The rail is not an ARIA tab set.** ArrowRight does not move between tabs, and there is no `tabpanel`. Count badges are glued into tab names ("Orders6", "Brief3"). | `audit/keyboard/summary.json` step 04; `shots/keyboard-04-rail-tabs-with-arrow-keys` | major |
| D-24 | **The map is unreachable by keyboard.** Both canvases have `tabIndex = -1`. There is no list alternative for fans, units, vehicles or hotspots on the map, and no skip link. | `audit/keyboard/summary.json` step 06 | major |
| D-25 | **Small text and small targets.** 102 of 125 visible text elements are under 14 px (53 at 12 px; some at 10–11 px). 40 of 54 controls are under 44 px. The 16×16 "?" tips and the 16 px replay slider fall below the [WCAG 2.2 target-size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) of 24 px. | `audit/views/summary.json` → `layout-main-dark` | major for field use, minor at a desk |
| D-26 | **Light-theme contrast.** The "critical" pill is 2.24:1 at 10 px. The active view button goes white-on-white when hovered. | `layout-main-light`; `shots/views-08-3d-light` ("3D" blank), `shots/incident-lightning-02-run-to-5-min-after-incident` ("All three" blank) | minor |
| D-27 | **Zoom buttons render blank in 2D and All three.** They use the fullwidth "＋/－" characters, which this machine's fonts lack. | `shots/views-05-all-three-dark` (two empty squares); `audit/tabs/03-tab-brief.txt` | minor |

### 4.5 Jargon, units and copy

| ID | Defect | Evidence | Severity |
| --- | --- | --- | --- |
| D-28 | **Model jargon in the primary UI.** "1 dot = 5 fans, 20,000 dots"; "Kev"; "Guessed from defaults"; "Crush-risk cell minutes"; "Weighted danger near the incident plus spillover: B 124960.3"; "Current geometric reach, not safety"; "0.2% of outdoor walkable area within reach"; "Rule-based ranking … Suggestions are not forecasts". | `audit/tabs/03-tab-brief.txt`, `04-tab-orders.txt`, `08-tab-about.txt`; `shots/incident-lightning-04-plans-verdict` | major |
| D-29 | **Machine phrasing.** "to On Olentangy River Road", "590 m from Gate 9 (WSW)", "seen for 0.0 min", "cleared the crowd at Stands", "compared with 1 past runs", "High … HIGH", "Result: after the incident", "arrives −56 min from kickoff". | `shots/police-02-orders-tab-suggestions`, `shots/incident-lightning-02-run-to-5-min-after-incident`, `shots/inspectors-02-click-a-fan`, `shots/tabs-05-tab-plans` | minor |
| D-30 | **Mixed units for a US police audience.** "12°C, wind 7 mph W, visibility 5+ km"; vehicles in metres with speed in mph; "PA radius in metres". | `shots/views-03-3d-dark`, `shots/inspectors-03-click-a-vehicle`, `shots/police-05-place-a-medical-marker` | minor |
| D-31 | **Personal names on simulated people.** "Dakota Brutus", with a "compliance" bar. Reads like tracking individuals in a tool whose rule is no identities. | `shots/inspectors-02-click-a-fan` | major (policy optics) |
| D-32 | **Demo artefacts in the operational UI.** "Demo sign-in, no account needed" in the officer console; "Template briefing: the AI writer was not running" on top of every verdict; the "What do you think?" box; the synthetic banner on every load. | `shots/officer-03-run-acknowledge-and-ask-for-backup`, `shots/incident-surge-03-plans-verdict` | minor |

### 4.6 Clutter, duplicates and the game look

| ID | Defect | Evidence | Severity |
| --- | --- | --- | --- |
| D-33 | **The Orders tab is a wall.** 8.2 screens, 73 controls, 18 headings, 1,032 words. | `audit/police/summary.json` → `metrics.rail-orders`; `shots/tabs-04-tab-orders` | major |
| D-34 | **Everything appears several times.** Density key ×3 (map legend, chips under the map, Map key tab). Weather up to ×5 (picker, "On the map", one card per map in All three). Plan switch ×3 (map title, Brief, plan cards). "Run all three plans" ×2 (toolbar and map). | `shots/views-03-3d-dark`, `shots/views-05-all-three-dark`, `shots/plan-editor-02-edit-a-step-and-add-a-step` | major |
| D-35 | **Overlays hide the data.** Inspector panels cover about a third of the map, including the weather and vehicle cards. The legend covers the lower left. The PA banner covers the map toolbar. The "Gate 1, 30/min" label sits under the toolbar. Hint text is drawn over figures. | `shots/inspectors-02-click-a-fan`, `shots/inspectors-04-click-an-officer`, `shots/police-10-order-log`, `shots/views-03-3d-dark` | minor |
| D-36 | **The header reflows as the clock text changes.** The role switch and theme button jump between rows at 1440 px. | `shots/views-03-3d-dark` vs `shots/views-04-2d-plan-dark` | minor |
| D-37 | **It looks like a game.** Voxel stadium, figurines, block cars. The 2D plan is letterboxed and uses two near-identical pin styles for gate numbers (1–12) and hotspot ranks (1–6). | `shots/views-03-3d-dark`, `shots/inspectors-03-click-a-vehicle`, `shots/views-04-2d-plan-dark` | major |

## 5. Requirements (PER-01 …)

Blockers first. Severity is the severity of the gap each requirement closes.

| ID | Need (testable) | Personas | Severity | Closes |
| --- | --- | --- | --- | --- |
| PER-01 | **One ranking source.** The verdict sentence, the ranking and the card order come from one function. The sentence names the metric it ranked by. Differences inside a stated tolerance are reported as ties. | P1, P7, P9, P2, P6 | blocker | D-01, D-02 |
| PER-02 | **Flat memory for any scenario length.** Keep full density grids only for recent frames and keyframes; downsample or recompute older ones. Give each map its own error boundary so one canvas never blanks the app. Acceptance: the suspicious package completes in a stock Chrome tab. | all | blocker | D-11, D-12 |
| PER-03 | **Gate screening model.** Lanes per gate; detector and wand throughput; staff; secondary-screening share; no-bag rejects returning to cars; express entry; medical and accessible entrances. Real gate names. Wait time in minutes. | P4, P9 | blocker | — |
| PER-04 | **Observation layer.** Camera and sensor zones on the map. Per-zone count, density and flow with uncertainty, latency and coverage. Sensor health. Observed and simulated side by side. Counts only: no faces, no identities, no frames kept by default. | P8, P2, P4, P9 | blocker | — |
| PER-05 | **Scenarios start near their incident**, from a checkpoint; an egress-time incident does not replay ingress. | P1, P7 | major | D-11 |
| PER-06 | **Saved, versioned plans and scenarios** (name, author, time) that survive reload and can be imported and exported. | P1, P2, P7, P9 | major | D-14 |
| PER-07 | **Branching.** "Play on from here" creates a branch, keeps the original, and compares the two. Destructive actions ask first. | P7, P1 | major | D-13 |
| PER-08 | **Seed ensemble.** N seeds per plan; cards show median and range; the ranking flags overlapping ranges. | P1, P7, P8, P10 | major | D-03 |
| PER-09 | **Metrics that discriminate.** Replace capped peak density with time and area above thresholds per zone. Grey out metrics that are equal across plans. | P1, P3, P6 | major | D-03 |
| PER-10 | **One calibrated alert level** shared by the Brief, the lists and the map. Thresholds stated with their basis. Queues, tailgating and seated crowds classed separately. | P2, P4, P8, P9 | major | D-04, D-05 |
| PER-11 | **Incident authoring.** Type, place, time, severity; concurrent incidents; timed injects. | P1, P7, P10 | major | — |
| PER-12 | **ICS / Unified Command model.** Roles, partner agencies, resource types, divisions or sectors. Export an ICS 201-style brief and an ICS 214-style activity log. | P1, P2, P10, P7, P6 | major | — |
| PER-13 | **Readable places everywhere.** Gate, section, lot, intersection ("Lane Ave & Olentangy River Rd"); never offsets such as "590 m from Gate 9". | P2, P3, P5 | major | D-29 |
| PER-14 | **Request and status board.** Requests show place, type, priority, age and assigned unit. Units show call sign, type, status, time in status and sector. | P2, P5, P6 | major | D-21, D-22 |
| PER-15 | **Preview and confirm high-impact orders**: bulk dispatch, road and gate closures (affected vehicles, detour, fans rerouted), release. Honour and label the chosen barricade type. | P2, P3, P4 | major | D-06 |
| PER-16 | **Officer console.** Fits 360–430 px without overflow. Assignment first. No simulation controls. Officer-set status. Targets of 48 px or more. A high-contrast outdoor theme. | P5 | major | D-18 – D-21 |
| PER-17 | **Real sign-in and permissions.** Officers cannot restart, switch the scenario, or change speed or weather. Every action is attributed to a person. | P5, P1, P10, P8 | major | D-19 |
| PER-18 | **Traffic operations.** Closure schedules; one-way and contraflow; ramp closures; traffic control point staffing; garages and off-map parking (or the missing share stated); transit; clearance time per lot. | P3, P10 | major | D-08 |
| PER-19 | **EMS / Fire layer.** First-aid stations; EMS units by type; access routes and fire lanes; casualty ranges with stated assumptions; hospital transport. | P6, P1, P10 | major | — |
| PER-20 | **Weather operations.** A lightning timer (time since last strike, 30-minute reset); shelter places with capacity; heat effects; US units (°F, mph, mi/ft). | P1, P6, P9, P10 | major | D-10, D-30 |
| PER-21 | **Exercise toolkit.** Objectives; MSEL and injects; evaluator notes; an AAR/IP export (strengths, areas for improvement, corrective actions, owners, commander feedback); multi-seat play on separate devices. | P7, P1, P10 | major | — |
| PER-22 | **Reproducible exports**: seed, plan definitions, decision tape, versions, wall clock and game clock, actor. JSON, CSV and PDF. Titles use the venue's name. | P7, P10, P1 | major | — |
| PER-23 | **The order log is an activity log**: wall clock and game clock, actor, order, place, reason, result. Filterable. | P1, P2, P7, P10 | major | — |
| PER-24 | **Professional map.** A 2D basemap with standard incident symbols, non-colliding labels and one legend. 3D, if kept, as real-geography massing without game styling. Panels never cover data. | P1, P8, P9, P10 | major | D-35, D-37 |
| PER-25 | **Declutter.** Each control lives in one place. Split Orders into task panes (Dispatch, Traffic, Gates, Alerts, Log). Put demo features behind a demo mode. | all | major | D-32 – D-34 |
| PER-26 | **Plain language.** Model terms move to About with definitions. Consistent clock rounding. No false precision. | all | major | D-07, D-28, D-29 |
| PER-27 | **Accessibility.** ARIA tab pattern; a keyboard-reachable map with a list alternative; a skip link; targets of 24 px or more (44 px for touch); body text 14 px or more; 4.5:1 contrast in every theme and state; no missing glyphs. | all, P5 most | major | D-23 – D-27 |
| PER-28 | **No personal names or per-person traits** on simulated people; describe groups. | P8, P9 | major | D-31 |
| PER-29 | **Public alerting.** Channels (PA, boards, venue app, WEA through the alerting authority); templates with 90/360-character limits; reach shown as an assumption with a range. | P9, P10, P1 | major | — |
| PER-30 | **Shareable read-only view and situation-report export** (with GeoJSON or KML) for EOC partners. | P10, P1, P6 | major | — |
| PER-31 | **Venue model**: sections, portals, concourses, exits, ADA routes. A gate and lane editor after import. Perimeter and secure-zone lines. | P9, P4, P3 | major | — |
| PER-32 | **Deployment hygiene**: self-hosted fonts and assets, works offline, an audit trail, a data-retention rule, a favicon. | P10, P8, P9 | minor | D-17 |
| PER-33 | **Import resilience**: fail within about 30 s with a plain message, cache results, accept a local OSM extract. | P9, P10 | minor | D-15 |
| PER-34 | **Wider area**: a configurable map radius or a regional traffic layer. | P3, P10 | minor | — |

## 6. Sources

All accessed 2026-10-27. Dates are page or article dates where the page gives one.

1. [Ohio Stadium facility page](http://www.ohiostatebuckeyes.com/sports/2023/7/6/ohio-stadium), OSU Athletics. Capacity 102,780.
2. [Ohio Stadium event policies](https://ohiostatebuckeyes.com/sports/2018/8/1/ohio-stadium-event-policies), OSU Athletics. No bags; small wallets only.
3. [Stadium screening page](https://ohiostatebuckeyes.com/sports/2023/6/1/tests), OSU Athletics. Walk-through metal detectors and hand wands.
4. [Ohio Stadium concert traffic and parking](https://ohiostatebuckeyes.com/sports/2026/4/6/concert-parking), OSU Athletics, 2026. Accessible shuttle by Gate 22/26.
5. [Ohio Stadium concert safety information](https://ohiostatebuckeyes.com/sports/2026/4/6/concert-emergency), OSU Athletics, 2026. Weather shelter in cars, French Field House, St. John Arena.
6. [What OSU football fans can bring to home games](https://www.desertsun.com/story/sports/college/football/2023/09/05/ohio-stadium-bag-policy-what-osu-football-fans-can-bring-to-home-games/70760322007/), The Desert Sun, 2023-09-05. Medical and childcare bag entrances by Gate 10 and the Press Entrance by Gate 23.
7. [Heading to the Shoe? 2026 season](https://abc6onyourside.com/news/local/heading-to-the-shoe-what-ohio-state-fans-need-to-know-for-the-2026-season), ABC6 / WSYX, 2026-09. Expanded express entry.
8. [Complex security at Ohio State–Michigan game](https://www.athleticbusiness.com/operations/safety-security/news/15148417/complex-security-at-ohio-state-michigan-game), Athletic Business, 2017-02. Agencies present.
9. [Game-day operations](https://fod.osu.edu/node/984), OSU Facilities Operations and Development, 2026-09. Concrete barriers and secure zones.
10. [Home football Saturday travel impacts](https://ttm.osu.edu/football_saturdays), OSU Transportation and Traffic Management, 2026-08. CABS suspension; traffic control officers.
11. [Game day parking](http://medicalcenter.osu.edu/patient-and-visitor-guide/osu-game-day-parking), OSU Wexner Medical Center. SR-315 ramp closures.
12. [Game day traffic, parking and other tips](https://www.daytondailynews.com/sports/what-to-know-about-ohio-state-game-day-traffic-parking-and-other-tips/article_0a8256a5-d46b-5983-a93b-00e8edff0b00.html), Dayton Daily News, 2026-09. Woody Hayes Drive closure; roads turning one-way.
13. [Homeland Security Exercise and Evaluation Program](https://www.fema.gov/emergency-managers/national-preparedness/exercises/hseep), FEMA, 2020.
14. [HSEEP Doctrine, 2020 revision](https://www.fema.gov/sites/default/files/2020-04/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2-25.pdf), FEMA.
15. [Exercise Evaluation Guides](https://preptoolkit.fema.gov/web/hseep-resources/eegs), FEMA PrepToolkit.
16. [NIMS ICS Forms Booklet (FEMA 502-2)](https://training.fema.gov/emiweb/is/icsresource/assets/nims%20ics%20forms%20booklet.v3.pdf), FEMA.
17. [ICS Form 201, Incident Briefing](https://training.fema.gov/emiweb/is/icsresource/assets/ics%20forms/ics%20form%20201,%20incident%20briefing%20%28v3%29.pdf), FEMA.
18. [ICS Form 205, Incident Radio Communications Plan](https://training.fema.gov/emiweb/is/icsresource/assets/ics%20forms/ics%20form%20205,%20incident%20radio%20communications%20plan%20%28v3.1%29.pdf), FEMA.
19. [Best practices for alerting authorities using WEA](https://www.fema.gov/emergency-managers/practitioners/integrated-public-alert-warning-system/public-safety-officials/alerting-authorities/best-practices), FEMA IPAWS, 2020-04. 90-character message plus optional 360.
20. [Lightning safety outdoors](https://www.weather.gov/safety/lightning-outdoors), National Weather Service. Wait 30 minutes after the last thunder.
21. [Understanding SC 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum), W3C WCAG 2.2.

Every other figure in this report was measured by the harness and points to its artifact. No numbers were assumed.

Content was rephrased for compliance with licensing restrictions.
