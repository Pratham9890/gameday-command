# 01 · Domain practice: how professional crowd-safety and event-command tools work

*Research note for Gameday Command v3. Written October 2026 from public sources fetched that month. Every figure has a source; "derived" marks my arithmetic on sourced figures. Paywalled texts (full NFPA 101, Green Guide, Purple Guide, ISO 20414) were not read in full; their numbers come from official worked examples, official summaries or code-hosting sites, as noted.*

## Summary

1. **Crowd tools are consultant tools.** MassMotion, LEGION, Pathfinder and crowd:it run offline for design and operations studies. Clients audit an assumption sheet, LoS and density maps, time-above-limit maps, flow counts and egress-time distributions. None compares plans for a commander at the same moment, which is Gameday's niche; the nearest analogue is accu:rate's REMSY research system.
2. **Credibility needs test suites and many runs:** IMO tests 1–12, RiMEA tests 1–16, NIST TN 1822 and ISO 20414, with results as distributions (IMO: 500 or more runs, 95th percentile).
3. **Gameday today runs one seed per plan.** Its per-cell peak density is capped at 5.0 p/m² and moves in 1.25 p/m² steps, so every README demo plan ties at 5.00. Practitioners use smoothed area density, LoS by type of space and time above a threshold.
4. **Command software records and coordinates but never simulates plans.** Between them, Esri SEO, WebEOC, Veoci, Everbridge, Genasys and HxGN OnCall cover COP maps, logs, tasking, resources, ICS forms and IAPs, notification and AAR. Gameday should export to them, not replace CAD, radio or notification.
5. **Doctrine has a place for Gameday.** NIMS builds an action plan from ICS 202/203/204/205/206/208 plus maps. HSEEP names the **game** as an exercise type, run from an MSEL and evaluated with EEGs and an AAR/IP.
6. **Practitioner numbers:**
   - flow: 82 / 66 persons per metre per minute (level / stepped)
   - entry: 660 per hour per entry point
   - egress: 8 minutes normal; 2.5–8 minutes in an emergency
   - staffing: 1 crowd manager per 250 people
   - a Life Safety Evaluation above 6,000 occupants
7. **Lightning practice has changed.** CISA/NCS4 (May 2026) make the 30/30 rule a last resort. They prefer NOAA 15/12/8-mile radii, with triggers set by how long sheltering takes. NCAA uses 30/12/8 miles.
8. **Ohio Stadium.** 102,041 seats; gates open 2 hours before kickoff. A **no-bag** policy, and a metal detector for everyone. Woody Hayes Drive closes 3 hours before kickoff. Multi-agency policing is led by OSU Police. There are no public egress times, SEAR rating or contraflow plan.
9. **Professional use needs:**
   - assumption sheets, ensembles and sensitivity
   - NASA-style caveats
   - append-only logs and printable ICS products
   - plain language, standard symbols and disciplined alerts
   - offline operation
   - a named decision-maker
10. Section 7 lists 35 requirements, DOM-01 to DOM-35.

## 1. Professional crowd-safety simulation tools

### 1.1 Tools at a glance

| Tool | Model | Licence | Practitioner use | V&V evidence |
| --- | --- | --- | --- | --- |
| [Oasys MassMotion](https://www.oasys-software.com/products/massmotion/) | Agent-based; BIM import; SDK | Commercial | Repeated scenario runs; tables, heatmaps and graphs of hot spots, waits and trip times; fly-through video for stakeholders | Used in peer-reviewed LoS studies, e.g. experienced density, maximum density and LoS D–F duration ([MDPI 2026](https://www.mdpi.com/2075-5309/16/16/3140)) |
| Bentley LEGION | In-house agent model | Commercial | Station and venue design reviews audited by the client (Crossrail, London Underground) | Calibrated and validated against empirical data ([Berrou et al. 2007](https://link.springer.com/doi/10.1007/978-3-540-47064-9_15)) |
| Thunderhead Pathfinder | Steering agents, or an "SFPE" mode with door flow limits | Commercial | Egress analysis for codes and performance-based design | Public V&V: IMO, NIST TN 1822, SFPE, fundamental diagrams ([V&V](https://www.thunderheadeng.com/docs/2024-1/pathfinder/verification-validation/), [NIST suite](https://www.thunderheadeng.com/docs/2025-1/pathfinder/appendices/verification-validation/nist/)) |
| [accu:rate crowd:it](https://www.accu-rate.de/en/crowdit/) | Optimal Steps Model | Commercial (free tier: 50 agents) | Evacuation analyses for events and buildings | Cites RiMEA tests and ISO 20414 ([PED 2025](https://amca-admin.rachel.puxdesign.cz/PED25/media/amca/2025/abstrakta/ped_2025_extended_abstract_38.pdf)) |
| [JuPedSim](https://www.jupedsim.org/stable/) | Python with a C++ core; speed and force models | **LGPL-3.0** ([repo](https://github.com/PedestrianDynamics/jupedsim)) | Research, including crowd-management measures | Jülich experiments |
| [Vadere](https://github.com/pedestrian-dynamics-HM/vadere) | Optimal steps, gradient navigation, social force | **LGPL-3.0** | Research | — |
| [PedPy](https://github.com/PedestrianDynamics/PedPy) | Trajectory analysis | MIT | Density, flow and speed from trajectories | — |

LGPL is outside the brief's preferred licences: use JuPedSim and Vadere only as external comparisons, never bundled.

### 1.2 How practitioners use them

- **Design and pre-event studies.** The [Crossrail Whitechapel LEGION report](https://learninglegacy.crossrail.co.uk/wp-content/uploads/2018/06/Whitechapel-Station-Legion-Modelling-C140-HYD-Z-RGN-D061-00079-2.0.pdf) shows the usual cycle:
  - The client issues demand and an **Assumption Cover Sheet**.
  - The modellers check flows, screenline counts, origin–destination totals and routeing.
  - The client audits the model (19 actions here; the significant ones were fixed and the model re-run).
  - The busiest 15 minutes are judged against LoS limits agreed per type of space (e.g. walkway LoS D in one-way passages, LoS C on two-way stairs).
- **Scenario comparison and egress.** Pathfinder's contour maps show density, LoS, congestion, time to exit and accumulated usage. Trailing-average (30 s by default) and maximum filters stop brief peaks from dominating ([contours](https://www.thunderheadeng.com/docs/2026-1/results/viewing-pathfinder-output/occupant-contours/)).
- **Event what-ifs.** [REMSY](https://amca-admin.rachel.puxdesign.cz/PED25/media/amca/2025/abstrakta/ped_2025_extended_abstract_38.pdf) (accu:rate with the City of Freiburg, PED 2025) grew out of workshops with police, fire, public-order officials, organisers and security staff.
  - Their questions: what if exits are blocked, where a threat appears, how many people get out in time.
  - Users set parameter ranges; REMSY runs every combination.
  - Variants that break criteria (e.g. more than 15 minutes to evacuate, more than 2 minutes of congestion delay) are dropped, and the rest are summarised on one chart.
- **Framing before modelling.** G. Keith Still's [RAMP](https://gkstill.com/Courses/elearning/Module05.html) looks at Routes, Areas, Movement over time and the Profile of the crowd. His [DIM-ICE](https://gkstill.com/Support/WhyModel/dimice.html) matrix crosses ingress, circulation and egress with design, information and management, in normal and emergency modes, rating each cell red, amber or green. Still warns that no single tool captures a crowd, and that models must be paired with monitoring of arrivals, queues and densities ([Still](https://gkstill.com/Support/WhyModel/EventModelling.html)).

### 1.3 Outputs clients and authorities expect

| Output | Meaning | Seen in |
| --- | --- | --- |
| Density / LoS maps | p/m², or Fruin A–F by type of space (walkway, stair, queue) | Pathfinder, LEGION, MassMotion |
| Cumulative Mean Density (CMD) | Mean density per area over a period | LEGION / Crossrail |
| Cumulative High Density (CHD) / LoS duration | How long each area stays above a limit | LEGION / Crossrail; MassMotion study |
| Maximum of averaged density | Worst value of a trailing-window mean | Pathfinder |
| Flows / screenlines | p/m/min through gates and doors | Crossrail; SGSA |
| Egress-time distribution | Histogram, minimum, maximum, mean, standard deviation, 95th-percentile "significant" time | [RiMEA](https://rimea.de/downloads/), [IMO](https://www.deutsche-flagge.de/de/redaktion/dokumente/interpretationen/solas/ii-2/msc-1-circ-1533-revised-guidelines-on-evacuation-analysis-for-new-and-existing-passenger-ships.pdf) |
| Congestion statistics | Duration, extent, accumulated delay, people involved | RiMEA §2.6 |

### 1.4 Crowd-science thresholds

Fruin's walkway and stair levels of service, from [Fruin 1971](https://onlinepubs.trb.org/Onlinepubs/hrr/1971/355/355-001.pdf), converted to metric (derived):

| LoS | Walkway m²/person | Walkway density (p/m²) | Walkway design flow (p/m/min) | Stair m²/person |
| --- | --- | --- | --- | --- |
| A | ≥3.25 | ≤0.31 | ≤23 | ≥1.86 |
| B | 2.32–3.25 | 0.31–0.43 | 23–33 | 1.39–1.86 |
| C | 1.39–2.32 | 0.43–0.72 | 33–49 | 0.93–1.39 |
| D | 0.93–1.39 | 0.72–1.08 | 49–66 | 0.65–0.93 |
| E | 0.46–0.93 | 1.08–2.15 | 66–82 | 0.37–0.65 |
| F | ≤0.46 | >2.15 | breakdown | ≤0.37 |

- **Stadium design level.** Fruin reserves LoS E for bulk exits such as stadium egress, and only with holding-area checks. The top of E (≈82 p/m/min, derived) matches the Green Guide's level-route flow.
- **Critical and extreme densities.** Still puts the critical density, above which flow falls, at roughly 2–3 p/m² ([Still](https://www.gkstill.com/Support/crowd-flow/fruin/Fruin1.html)). Fruin describes a crowd at about 7 p/m² as almost a fluid mass that carries shock waves ([Fruin 1993](https://gkstill.com/Support/crowd-flow/fruin/Fruin2.html)).
- **Pressure as a warning sign.** [Helbing et al. 2007](https://arxiv.org/html/physics/0701203v2) measure "crowd pressure" as density × variance of speed. The Jamarat accident followed about 10 minutes after pressure passed 0.02/s², with stop-and-go waves earlier. The thresholds depend on the measurement radius.

Gameday's 4 p/m² danger line already lies deep inside LoS F and falls between the engine's density steps (3.75 and 5.0). Its jam density of 5.4 p/m² ([`movement-flow.ts`](../../engine/src/movement-flow.ts)) means it cannot represent a crush.

### 1.5 Validation regimes

- **[IMO MSC.1/Circ.1533](https://www.deutsche-flagge.de/de/redaktion/dokumente/interpretationen/solas/ii-2/msc-1-circ-1533-revised-guidelines-on-evacuation-analysis-for-new-and-existing-passenger-ships.pdf)** (2016):
  - Four forms of verification: component, functional, qualitative and quantitative.
  - Twelve tests, e.g. walking speed, a 1 m door passing at most 1.33 p/s, corners, counterflow, halving the exits roughly doubling the time, stair congestion, and flow falling at high density.
  - At least 500 runs per case (50 if converged), reported at the 95th percentile, with assumptions documented.
- **[RiMEA 4.1.1](https://rimea.de/downloads/)** (2025):
  - 16 tests. Test 8 is a one-at-a-time parameter study.
  - Congestion means speed below a model-specific threshold of 0.2–0.8 m/s.
  - Positions and demographics are re-randomised every run.
  - Reports give a histogram, minimum, maximum, significant time, standard deviation, assumptions and the number of runs.
- **[NIST TN 1822](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.1822.pdf)** (2013): tests five core components — pre-evacuation time, movement and navigation, exit usage, route availability and flow constraints. It handles behavioural uncertainty with convergence criteria across runs.
- **[ISO 20414:2020](https://www.iso.org/standard/78348.html)** is the international V&V protocol for evacuation models.
- **Pathfinder's definitions** follow IEEE 1012 / ISO 16730-1: verification checks the code against the model, validation checks the model against reality. Its manual says results only supplement a qualified user's judgement ([Pathfinder](https://www.thunderheadeng.com/docs/2024-1/pathfinder/verification-validation/)).

## 2. Event and incident command software

### 2.1 Shared features

| Product | Main features |
| --- | --- |
| [Esri Special Event Operations](https://doc.arcgis.com/en/arcgis-solutions/12.1/reference/introduction-to-special-event-operations.htm) 3.x | Planner app (road closures, staffing posts, batch staff import, reuse of past events, maps for ArcGIS Mission); mobile staff maps; public maps. Older versions had a command-centre app with NWS radar. The *Crowd Counter* and *After Action* apps were removed. |
| WebEOC Nexus (Juvare) | Shared boards. An [IAP board](https://docs.juvare.com/webeoc-onnexa/board-list/board-incident-action-plan.htm) holds one plan per operational period. Map-enabled [Requests/Tasks](https://docs.juvare.com/webeoc-onnexa/board-list/board-requests-tasks.htm); NIMS-aligned [resource requests, inventory and deployments](https://docs.juvare.com/webeoc-onnexa/board-list/board-requests-inventory-and-deployments.htm); SITREPs. |
| [Veoci (TCU game day)](https://veoci.com/blog/tcu-emergency-planning-game-day) | Game-day COP dashboard: incidents, tasks, weather, staffing, IAPs. Staff SMS with polls; incident intake by QR code or text; live maps; public dashboards; hot-wash items feed after-action analytics. |
| [Everbridge Visual Command Center](https://www.everbridge.com/products/visual-command-center/) | COP fusing risk feeds (incl. NWS); KML layers; status-board and video-wall channels; mass notification; optional fully automatic incident launch ([Auto Incident](https://supportcenter.everbridge.com/hc/en-us/articles/54904609492123-VCC-How-Always-Alert-and-Auto-Incident-Control-Automatic-Alerts-and-Incidents-in-Visual-Command-Center)). |
| [Genasys](https://www.genasys.com/stadiums-and-events) | Zone-based alerts by SMS, cell broadcast, LRAD acoustic speakers, signage and social; Wi-Fi auto-discovery; secure staff chat; audible alerts that work without power or network. |
| [HxGN OnCall Planning & Response](https://sigblog.hexagon.com/hxgn-oncall-planning-response-the-best-asset-for-major-event-management/) | ICS-aligned COP, action plans, documents, org charts and a CAD link; every user action audit-logged for review, legal work and training. |
| [Motorola CommandCentral Aware](https://www.motorolasolutions.com/content/dam/msi/docs/global-software/commandcentral-aware/cc_aware_brochure_web.pdf) | Real-time map of units and events, on top of CAD. |

### 2.2 What Gameday adds, and what it must not replace

**What Gameday adds:**
- The same crowd and seed run under up to three plans, before an event or in an exercise.
- Outcome metrics these systems do not compute: time to clear, LoS duration, officer minutes, ambulance access time.
- Auditable replays, through decision tapes.
- A training product.

Hexagon notes that CAD is built for short incidents with few resources ([Hexagon](https://blog.hexagon.com/managing-major-incidents-with-planning-response-technology/)). Simulating planned events is the gap between CAD and the EOC tools.

**What Gameday must not replace:** CAD dispatch, LMR/FirstNet radio, mass notification, the official incident record (WebEOC/Veoci), CCTV, and ticketing or access control. Gameday exports to these systems and never alerts, dispatches or launches incidents itself.

## 3. Doctrine and standards

### 3.1 NIMS/ICS ([NIMS 3rd ed., 2017](https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf))

- **Management characteristics.** NIMS lists 14, including common terminology, management by objectives, action planning, span of control (1 supervisor to 5 people is the optimal guideline), unity of command and Unified Command (UC).
- **Unified Command.** Agencies that share authority agree one set of objectives and approve one IAP per operational period.
- **The Planning "P".** Operational periods typically run 12–24 hours. Each period repeats: objectives, strategy, tactics meeting (ICS 215/215A), planning meeting, IAP approval, briefing.
- **Language and data.** Plain language replaces codes and agency jargon wherever several agencies work together. Data should follow NIEM and the US National Grid.
- **Planned events.** FEMA [IS-15.b](https://training.fema.gov/is/courseoverview.aspx?code=is-15.b&lang=en) applies the same cycle to special events.
- **Spell out "EAP".** NCAA uses it for *Event* Action Plan; NFPA and NCS4 for *Emergency* Action Plan.

### 3.2 ICS forms in an Incident or Event Action Plan ([NIMS ICS Tab 9](https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf))

| Form | Holds | In IAP? |
| --- | --- | --- |
| 201 Incident Briefing | Situation, actions, organisation and resources at the start or at a handover of command; may be the only record of a small incident | No |
| 202 Incident Objectives | Objectives for the period, weather, safety message, contents; IC/UC signature approving the plan | Yes |
| 203 Organization Assignment List | Who holds each command and supervisory post | Yes |
| 204 Assignment List | One per division or group: supervisor, resources and headcount, tasks, special instructions, radio channels | Yes |
| 205 / 205A | Radio frequency plan; non-radio contact list | Yes |
| 206 Medical Plan | Medical care for responders | Yes |
| 208 Safety Message/Plan | Safety message and site safety plan | Yes |
| 214 Activity Log | Time-stamped notable activities, per unit or person | Record |
| 215 / 215A | Tactical planning worksheet; IAP safety analysis | Planning aid |

The IAP also carries maps, and as needed a traffic plan, site security plan, evacuation plan and meeting schedule (ICS 230).

### 3.3 HSEEP ([2020 doctrine](https://www.fema.gov/sites/default/files/2020-04/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2-25.pdf))

- **Cycle:** program management, design and development, conduct, evaluation, improvement planning.
- **Discussion-based exercise types:** seminars, workshops, tabletop exercises (TTX) and **games**. Operations-based types are drills, functional exercises and full-scale exercises.
- **A game** simulates operations to explore what player decisions lead to. It runs on rules and data, centres on critical decision points, supports what-if analysis of plans, uses no real resources and may use models. This is Gameday's doctrinal category.
- **Every MSEL entry** has an event number, scenario time, event type (inject, contingency inject or expected action), inject mode, sender, recipient, message, expected response, objective and notes.
- **Evaluation and debrief.** EEGs tie observations to capability targets, each made of a critical task, an impact and a timeframe. A hot wash follows the exercise. The AAR/IP sorts findings into strengths and areas for improvement, with corrective actions.

### 3.4 NCS4 and NCAA practice

- **NCS4.** The [Intercollegiate Best Practices](https://drulibrary.uoregon.edu/sites/default/files/rpds/entry/file_for_download/2015_NCS4_Intercollegiate_Best_Practices_Guide.pdf) (2015 is the latest public edition; newer ones are on the [NCS4 portal](https://ncs4.usm.edu/knowledgeportal/best-practices)) recommend:
  - joint planning, with event operations kept separate from public safety
  - a tabletop exercise every year
  - each jurisdiction commanding its own resources until an incident triggers ICS
  - a command matrix
  - agency representatives with authority to decide
- **NCAA.** The [2024-25 best practices](https://ncaaorg.s3.amazonaws.com/championships/resources/common/2024-25NCAAChamp_BestPracticesVenueSafetySecurity.pdf) (Feb 2025) call for:
  - an exercise 30 or more days before the event
  - an incident briefing before each competition
  - an AAR after every event
  - **time-based** weather triggers, since a fast storm can make a 12-mile alert too late

### 3.5 CISA/DHS venue guidance

- **Bag search** ([July 2026](https://www.cisa.gov/sites/default/files/2026-08/FINAL_Public_Venue_Bag_Search_Procedures_AUG2026_508.pdf)): search everyone whatever the wait, size lanes to the expected flow (e.g. from ticket sales), steer people to shorter lines, use secondary perimeters, and post uniformed officers between search and ticket scan.
- **Screening** ([2026](https://www.cisa.gov/sites/default/files/2026-08/FINAL_Public_Venue_Security_Screening_AUG2026_508.pdf)): one person at a time through walk-through metal detectors, and pause the flow if people bunch up past the detector.
- **Vehicles** ([April 2024](https://www.cisa.gov/sites/default/files/2024-04/Vehicle_Incident_Prevention_and_Mitigation_Security_Guide_508_20240418.pdf)): layer the mitigations; manage crowds through time, space, protective measures and information; avoid chokepoints and give more than one way out; separate pedestrians from traffic; plan a first-responder route. The guide points to MGT-475 crowd-management training, delivered by NCS4.
- **Evacuation** ([Evacuation Planning Guide for Stadiums, 2008](https://www.cisa.gov/sites/default/files/publications/evacuation-planning-guide-stadiums-508.pdf)): choose between full, partial or directed evacuation, shelter in place, and relocation. Base the choice on time and distance, with the decision-maker and criteria set in advance. Always consider sheltering in place.
- **Risk rating.** DHS rates submitted events [SEAR 1–5](https://www.dhs.gov/sites/default/files/publications/19_0905_ops_sear-fact-sheet.pdf); 1 needs the most federal support. See also the [Mass Gathering Security Planning Tool](https://www.cisa.gov/resources-tools/resources/mass-gathering-security-planning-tool).

### 3.6 Life-safety codes

- **NFPA 101** ([NFPA Journal 2021](https://www.nfpa.org/News-and-Research/Publications-and-media/NFPA-Journal/2021/Fall-2021/In-Compliance/NFPA-101)):
  - Assembly occupancies over 6,000 people need a Life Safety Evaluation covering at least 10 conditions.
  - Emergency action plans need at least 18 items and go to the authority having jurisdiction (AHJ).
  - Trained crowd managers are needed at 1 per 250 occupants.
- **Ohio follows the IFC, not NFPA 101.** The [Ohio Fire Code](http://codes.ohio.gov/assets/laws/administrative-code/rules/1301/7/1301$7-7-04_eff_11_20_25.pdf) adopts IFC 2021 Chapter 4 (effective 20 Nov 2025). IFC 403.12.3 sets crowd managers at 1:250 for gatherings over 1,000 people, unless the fire code official approves fewer ([UpCodes](https://up.codes/s/crowd-managers-for-gatherings-exceeding-1-000-people)). For 102,041 people that is about 408 (derived).
- **IBC exit width factors** (inches per person):
  - stairs 0.3; other components 0.2 ([UpCodes](https://up.codes/s/required-capacity-based-on-occupant-load))
  - open-air seating aisles: 0.08 stepped, 0.06 level ([UpCodes](https://up.codes/s/open-air-assembly-seating))
  - smoke-protected seating of 25,000+ seats: 0.060 on stairs, 0.044 in passageways ([UpCodes](https://up.codes/s/smoke-protected-seating))

  The factors encode a timed egress: one consultant links the 20,000-seat values to 9 min 20 s ([FP&C letter](https://www.portlandoregon.gov/bds/appeals/index.cfm?action=getfile&appeal_id=31827&file_id=40845); secondary source).

### 3.7 UK Green Guide and Purple Guide

The [Green Guide](https://sgsa.org.uk/green-guide/) is in its 6th edition (2018). That edition added "Zone Ex", the area outside the ground where fans arrive and leave. A 7th edition is in consultation ([2025](https://sgsa.org.uk/wp-content/uploads/2025/05/Green-Guide-7-early-consultation.pdf)).

[Worked Example A](https://sgsa.org.uk/wp-content/uploads/2024/02/Worked-Example-A-Football-and-Rugby.pdf) sets out the method:
- **Safe capacity** is the lowest of holding, entry, exit and emergency-exit capacity.
- **Exit capacity** is width × time × rate. For example, 6 m × 8 min × 66 p/m/min = 3,168 people.
- **Heightened security.** Manual searches were expected to cut entry to about 350 people per hour per entry point. The options were more stewards with earlier arrival, a delayed start, or a lower capacity.

SGSA also lists weather, clothing, time of day and children as factors that change flow ([SGSA](https://sgsa.org.uk/physical-factors/circulation/)).

The Purple Guide (Events Industry Forum) is subscription-only ([council note](https://www.eastsuffolk.gov.uk/sites/default/files/2025-06/Guidance%20for%20planning%20an%20event%20and%20producing%20an%20Event%20Management%20Plan.pdf)). None of its figures are used here.

### 3.8 Weather: lightning and heat

- **Lightning** ([CISA/NCS4, May 2026](https://www.cisa.gov/sites/default/files/2026-05/Lightning_Safety_Guide_508_05122026.pdf)):
  - **Triggers.** NOAA uses three radii: at 15 miles management is notified, at 12 miles the threat is impending, and at 8 miles or less the event is delayed. 8 miles is a minimum: about 20% of strikes land beyond it, and "bolts from the blue" can reach up to 20 miles.
  - **Lead time.** An organised storm calls for 30 minutes or more of lead time to evacuate. Plans should budget the time to decide, clear the stands, walk to shelter and get inside.
  - **Resume** when a meteorologist with real-time data confirms lightning is beyond 8 miles and moving away, with no new threat inside 8 miles. Otherwise wait 30 minutes after the last thunder or lightning. The 30/30 rule is a last resort.
  - **Roles.** Name a Weather Safety Official and an Authorized Decision-Maker, and log a timeline.
  - **Fan messaging.** In the guide's survey, venues reached fans by PA (92%), social media (73%), video boards (67%) and mass mobile messaging (52%).
  - **NCAA stages** are Yellow at 30 miles, Orange at 12, and Red at 8 (play stops and the venue is cleared) ([NCAA](https://ncaaorg.s3.amazonaws.com/championships/resources/common/2024-25NCAAChamp_BestPracticesVenueSafetySecurity.pdf)).
- **Heat:**
  - **Spectators.** NCAA points venues to NWS HeatRisk: an experimental 0–4 scale, forecast 7 days ahead and based on CDC heat-health thresholds ([NWS](https://www.weather.gov/safety/heat-tools)).
  - **Active people** (staff, athletes) are covered by WBGT. Regional athlete guidelines stop training at WBGT 29.0, 31.0 or 32.3 °C in Regions 1, 2 and 3 ([Grundstein et al.](https://pmc.ncbi.nlm.nih.gov/articles/PMC5800727/)).
  - **Columbus** is probably in Region 2, which includes the Ohio Valley; verify on the map.

### 3.9 Key numbers practitioners use

| Quantity | Value | Source |
| --- | --- | --- |
| Peak specific flow | 1.22 (Weidmann), 1.25 (Fruin), 1.32 (SFPE) p/m/s at 1.75–1.97 p/m²; about 73–79 p/m/min (derived) | RiMEA Table 1 |
| Door test | No more than 1.33 p/s through a 1 m door | IMO Test 4 |
| Flow rates used in calculations | 82 p/m/min level, 66 p/m/min stepped; 660 entries per hour per entry point | SGSA |
| Normal egress | 8 min from seat to exit system ("Zone 2 travel time") | SGSA |
| Emergency egress | 2.5 / 6 / 8 min for high / medium / low fire risk | SGSA |
| Illustration only | 102,041 ÷ (8 min × 66) ≈ 193 m of stepped exit width (derived, UK method) | — |
| Densities | 4.7 p/m² on terraces; 3.5–4.7 p/m² starting density for standing areas; critical about 2–3 p/m²; "fluid" crowd about 7 p/m² | SGSA, RiMEA, Still, Fruin |
| Staffing | Crowd managers 1:250; span of control 1:5 | IFC/OFC, NFPA; NIMS |
| Ensemble | At least 500 runs (50 if converged), 95th percentile | IMO |

## 4. What makes such a tool credible to professionals

- **Repeatable V&V.** Publish results for the IMO, RiMEA and NIST test cases, and keep verification and validation separate, as Pathfinder does.
- **Stated assumptions.** An assumption cover sheet for each run, agreed and audited by the client (Crossrail); documented algorithms (IMO §6, RiMEA §5); and a model description in ODD format ([Grimm et al. 2020](https://www.jasss.org/23/2/7.html)).
- **Uncertainty.** Report distributions across seeds and re-sampled populations, check convergence, and give percentiles (IMO, NIST, RiMEA). Show the uncertainty, not only a single number ([NRC 2006](https://nap.nationalacademies.org/catalog/11699)).
- **Sensitivity and provenance.** Sweep one parameter at a time (RiMEA Test 8). [NASA-STD-7009B](https://standards.nasa.gov/sites/default/files/standards/NASA/B/1/NASA-STD-7009B-Final-3-5-2024.pdf) (2024) treats sensitivity analysis and input pedigree, the traceable source of every input, as credibility factors.
- **Reporting to decision-makers** (NASA §4.3.8): a best estimate; an uncertainty statement, or a clear "none available"; a credibility assessment; caveats and the risks of accepting the result; and explicit warnings when assumptions or limits are broken or the run raised errors. Gameday's fallback-decision count is this kind of warning.
- **Audit trail and reproducibility.** Log every action (HxGN) in ICS 214 style, and keep "same seed + same tape = same run". The [AQuA Book](https://www.gov.uk/guidance/the-aqua-book) asks for assurance in proportion to what rests on the analysis.
- **Printable products.** IAPs circulate on paper or electronically (NIMS).
- **Plain language under stress.** NIMS requires it. Displays should support Endsley's three levels of situation awareness: perceive what is happening, understand it, and project what comes next ([Endsley 1995](https://doi.org/10.1518/001872095779049543)).
- **Respect the chain of command.** The IC or Unified Command approves the plan (NIMS), the lightning guide names an Authorized Decision-Maker, and NCS4 sets decision authority in advance. Pathfinder's disclaimer says the tool only supplements judgement.

## 5. Game day at Ohio Stadium (public sources only)

| Item | Public fact | Confidence |
| --- | --- | --- |
| Capacity | 102,041 per the [official page](https://ohiostatebuckeyes.com/sports/2023/7/6/ohio-stadium) (Oct 2026); older listings say 102,780, so the figure changes with renovations | High |
| Gates | Open 2 h before kickoff. Use the gate on the ticket: Block O at Gate 34, premium near Gate 17 ([A–Z guide](https://ohiostatebuckeyes.com/sports/2022/4/11/az-guide)) | High |
| Screening | **No-bag** policy: wallets up to 5×8×1 in. only. **Everyone passes a metal detector.** Medical and childcare bags enter via the Band Center doors (between Gates 10 and 12) or the Security/Press entrance (near Gate 23). No re-entry. ([A–Z](https://ohiostatebuckeyes.com/sports/2022/4/11/az-guide), [policies](https://ohiostatebuckeyes.com/sports/2018/8/1/ohio-stadium-event-policies)) | High |
| Medical | 7 first-aid stations staffed by Columbus Fire paramedics and Red Cross volunteers ([policies](https://ohiostatebuckeyes.com/sports/2018/8/1/ohio-stadium-event-policies)) | High |
| Fan communications | PA, stadium screens, Gameday Alerts texts, Buckeye Alert ([emergency.osu.edu](https://emergency.osu.edu/)) | High |
| Weather posture | Shelter in place on the concourses. People outside use cars, French Field House or St. John Arena. Taken from the concert page ([2026](https://ohiostatebuckeyes.com/sports/2026/4/6/concert-emergency)); football practice may differ | Medium |
| Road closures | Woody Hayes Drive hard-closed 3 h before kickoff ([DPS](https://dps.osu.edu/golf-cart-event-access-pass)), between Cannon Drive and Tuttle Park Place ([Dayton Daily News, Sept 2026](https://www.daytondailynews.com/sports/ohio-state-football-game-day-traffic-parking-and-other-tips-what-to-know/article_0a8256a5-d46b-5983-a93b-00e8edff0b00.html)) | High |
| Transit | Campus buses (CABS) suspended from 6 h before kickoff to 2 h after; free shuttle from 6 h before to 90 min after ([TTM](https://ttm.osu.edu/football_saturdays)) | High |
| Freeway and hospital access | SR-315 ramp to Lane Ave may close at times; Medical Center Drive ramp stays open; emergency traffic let through to the Wexner ED ([Wexner](https://wexnermedical.osu.edu/patient-and-visitor-guide/osu-game-day-parking)) | High |
| Contraflow | Only a press note that nearby streets can become one-way; no public contraflow plan found ([DDN](https://www.daytondailynews.com/sports/ohio-state-football-game-day-traffic-parking-and-other-tips-what-to-know/article_0a8256a5-d46b-5983-a93b-00e8edff0b00.html)) | Low |
| Barriers and entry tech | Press-reported: new vehicle barriers of about 600 lb each, and optional "secure facial authentication" at entry ([DDN](https://www.daytondailynews.com/sports/ohio-state-football-game-day-traffic-parking-and-other-tips-what-to-know/article_0a8256a5-d46b-5983-a93b-00e8edff0b00.html)) | Medium |
| Agencies | OSU Police leads and has mutual aid with Columbus Police ([OSU](http://president.osu.edu/story/commitment-safety-well-being)). OSHP takes part, including its Ohio Investigative Unit ([OSU](https://u.osu.edu/studentconduct/2022/08/18/game-day-keeping-out-of-handcuffs/)). The Franklin County Sheriff, FBI, DHS, TSA and US Army were reported at the 2017 Michigan game ([Athletic Business](https://www.athleticbusiness.com/operations/safety-security/news/15148417/complex-security-at-ohio-state-michigan-game)). Columbus Fire paramedics staff the first-aid stations. | Medium |
| Exercises | OSU Police ran mock scenarios at the stadium before the Aug 2025 Texas game ([NBC4](https://www.nbc4i.com/news/local-news/ohio-state-university/ohio-state-police-increases-security-ahead-of-saturdays-big-game/)) | Medium |
| Not public | SEAR rating, egress times and the official gate list. The repo's 11 OSM gates need verifying. | Unknown |

## 6. How these apps should work for professional use

- **Follow the operating rhythm.** Plan weeks ahead (with an exercise 30+ days out), brief before each event, run and log during it, and hold a hot wash and AAR after every event (NCAA, NIMS, HSEEP). Products split apps by phase and role; Esri, for example, has separate planner, staff and public apps.
- **Keep roles separate:** planner, decision-maker, field user, exercise controller and evaluator. The Weather Safety Official is not the Authorized Decision-Maker.
- **Map conventions.** Use [ANSI INCITS 415-2006](https://webstore.ansi.org/standards/incits/incits4152006r2022) symbols: incidents are diamonds, operations circles, infrastructure rectangles ([FGDC](https://www.fgdc.gov/hswg/ref_pages/SymbolFAQ_ref.htm)). Give locations as gate, section and street, with US National Grid references (NIMS).
- **Alert discipline.** Trigger on the time left to act (NCAA). Rank and rate-limit alerts: alarm management measures alarm rates and floods ([ISA-18.2](https://www.isa.org/getmedia/55b4210e-6cb2-4de4-89f8-2b5b6b46d954/PAS-Understanding-ISA-18-2.pdf)), with a flood commonly defined as 10+ alarms in 10 minutes per operator ([secondary](http://www.digitalrefining.com/article/1000558,Alarm_floods_and_plant_incidents_.html)). Never launch actions automatically; Everbridge's Auto Incident is the counter-example.
- **Interoperability.** Export GeoJSON/KML layers (for ArcGIS and Everbridge), PDF forms, CAP 1.2 message drafts in the format IPAWS uses ([OASIS](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.pdf), [IPAWS profile](http://docs.oasis-open.org/emergency/cap/v1.2/ipaws-profile/v1.0/cap-v1.2-ipaws-profile-v1.0.pdf)), [EDXL-SitRep](https://docs.oasis-open.org/emergency/edxl-sitrep/v1.0/cs02/edxl-sitrep-v1.0-cs02.pdf) situation reports and NIEM vocabulary.
- **Resilience.** Run on-device with no network, as Genasys designs its audible alerts to, and make everything printable.
- **Accessibility.** Never carry meaning by colour alone: about 1 in 12 men of Northern European ancestry have red–green colour vision deficiency ([MedlinePlus](https://medlineplus.gov/download/genetics/condition/color-vision-deficiency.pdf)). Meet [WCAG 2.2](https://www.w3.org/TR/WCAG22/) contrast.
- **Data ethics.** Keep zone-level counts only, even if the venue scans faces at entry (hard rule).

## 7. Implications for Gameday Command

1. **DOM-01** Report density as Fruin LoS by type of space (walkway, stair, queue) as well as p/m². It is the language AHJs and consultants read ([Fruin 1971](https://onlinepubs.trb.org/Onlinepubs/hrr/1971/355/355-001.pdf)).
2. **DOM-02** Add three maps: cumulative mean density, time above a selectable threshold, and the maximum of averaged density. These are the standard audited outputs ([Crossrail](https://learninglegacy.crossrail.co.uk/wp-content/uploads/2018/06/Whitechapel-Station-Legion-Modelling-C140-HYD-Z-RGN-D061-00079-2.0.pdf), [Pathfinder](https://www.thunderheadeng.com/docs/2026-1/results/viewing-pathfinder-output/occupant-contours/)).
3. **DOM-03** Replace the per-cell peak with smoothed area density, and flag the 5.0 p/m² ceiling and 1.25 p/m² steps; today every plan ties at 5.00 ([`movement-flow.ts`](../../engine/src/movement-flow.ts)).
4. **DOM-04** Measure flows in p/m/min at gates, vomitories and crossings, against 82 / 66 p/m/min and 660 per hour per entry point. These are the numbers safety officers check ([SGSA](https://sgsa.org.uk/wp-content/uploads/2024/02/Worked-Example-A-Football-and-Rugby.pdf)).
5. **DOM-05** Make screening throughput a sourced, editable parameter for each gate. The no-bag policy and universal metal detection make screening the entry bottleneck ([OSU A–Z](https://ohiostatebuckeyes.com/sports/2022/4/11/az-guide), [SGSA](https://sgsa.org.uk/wp-content/uploads/2024/02/Worked-Example-A-Football-and-Rugby.pdf)).
6. **DOM-06** Report egress as the times by which 50%, 90%, 95% and 100% of each stand reach the exit system and clear Zone Ex, against the 8-minute reference. Egress is judged on distributions ([SGSA](https://sgsa.org.uk/wp-content/uploads/2024/02/Worked-Example-A-Football-and-Rugby.pdf), [RiMEA](https://rimea.de/downloads/)).
7. **DOM-07** Compute RiMEA congestion statistics (duration, extent, accumulated delay, people involved) from a speed threshold. It is a definition reviewers can check ([RiMEA](https://rimea.de/downloads/)).
8. **DOM-08** Run an ensemble of seeds per plan. Show the median and the 90th/95th percentiles, the number of runs and whether the results have converged, and flag when the ranking of plans flips. One seed is not evidence ([IMO](https://www.deutsche-flagge.de/de/redaktion/dokumente/interpretationen/solas/ii-2/msc-1-circ-1533-revised-guidelines-on-evacuation-analysis-for-new-and-existing-passenger-ships.pdf), [NIST TN 1822](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.1822.pdf)).
9. **DOM-09** Add one-at-a-time sensitivity sweeps (arrival curve, walking speed, gate rate, compliance with PA messages) showing which assumption drives the result ([RiMEA Test 8](https://rimea.de/downloads/), [NASA-STD-7009B](https://standards.nasa.gov/sites/default/files/standards/NASA/B/1/NASA-STD-7009B-Final-3-5-2024.pdf)).
10. **DOM-10** Run IMO tests 1–12, the relevant RiMEA tests and the NIST verification tests in CI, and publish the results. This is the minimum bar for an evacuation model ([IMO](https://www.deutsche-flagge.de/de/redaktion/dokumente/interpretationen/solas/ii-2/msc-1-circ-1533-revised-guidelines-on-evacuation-analysis-for-new-and-existing-passenger-ships.pdf), [ISO 20414](https://www.iso.org/standard/78348.html)).
11. **DOM-11** Validate against Jülich experiments (including stadium stairs and vomitories) using PedPy (MIT). Use LGPL simulators only as external comparisons ([Jülich](https://ped.fz-juelich.de/da/doku.php), [PedPy](https://github.com/PedestrianDynamics/PedPy)).
12. **DOM-12** Publish what the model cannot represent (above 5.4 p/m², turbulence, pushing) and warn when a run reaches it. Crush dynamics are out of scope ([Fruin 1993](https://gkstill.com/Support/crowd-flow/fruin/Fruin2.html), [Helbing 2007](https://arxiv.org/html/physics/0701203v2)).
13. **DOM-13** Print an assumption cover sheet with every run, record where each input came from, and keep an ODD model description. Clients audit assumptions first ([Crossrail](https://learninglegacy.crossrail.co.uk/wp-content/uploads/2018/06/Whitechapel-Station-Legion-Modelling-C140-HYD-Z-RGN-D061-00079-2.0.pdf), [ODD](https://www.jasss.org/23/2/7.html)).
14. **DOM-14** Every scorecard and briefing carries a best estimate, its uncertainty, caveats and warnings (fallback decisions, limits exceeded), as NASA's reporting standard requires ([NASA-STD-7009B](https://standards.nasa.gov/sites/default/files/standards/NASA/B/1/NASA-STD-7009B-Final-3-5-2024.pdf)).
15. **DOM-15** Shape the product around the Planning P: plan, brief, run or exercise, then hot wash and AAR. It is the rhythm police already work to ([NIMS](https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf), [HSEEP](https://www.fema.gov/sites/default/files/2020-04/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2-25.pdf)).
16. **DOM-16** Use NIMS terms and plain language instead of jargon like "Kev" or "crush-risk cell minutes"; several agencies share the screen ([NIMS](https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf)).
17. **DOM-17** Model each plan as ICS 202 objectives plus ICS 204 assignments, and export a draft IAP/EAP PDF (202/203/204/205/206/208 plus a map). Commanders brief from this format ([NIMS Tab 9](https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf)).
18. **DOM-18** Keep an append-only, time-stamped activity log of every commander action, in ICS 214 style, for review, legal and training use ([NIMS](https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf), [HxGN](https://sigblog.hexagon.com/hxgn-oncall-planning-response-the-best-asset-for-major-event-management/)).
19. **DOM-19** Add an HSEEP "game" mode: an MSEL editor with the standard fields, injects and contingency injects, plus controller and evaluator roles ([HSEEP](https://www.fema.gov/sites/default/files/2020-04/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2-25.pdf)).
20. **DOM-20** Evaluate against EEG capability targets (critical task, impact, timeframe) and export an AAR/IP of strengths and areas for improvement. Agencies file this deliverable ([HSEEP](https://www.fema.gov/sites/default/files/2020-04/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2-25.pdf)).
21. **DOM-21** Assign each plan step to an agency in a Unified Command matrix (OSU Police, Columbus Police, OSHP, Columbus Fire, event operations) and warn when span of control goes past 1:5 ([NCS4](https://drulibrary.uoregon.edu/sites/default/files/rpds/entry/file_for_download/2015_NCS4_Intercollegiate_Best_Practices_Guide.pdf), [NIMS](https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf)).
22. **DOM-22** Make lightning triggers time-based. Use editable 15/12/8 and 30/12/8-mile radii, compare storm speed with the modelled time to shelter people, apply the resume rules, assign Weather Safety Official and Decision-Maker roles, and keep a timeline ([CISA 2026](https://www.cisa.gov/sites/default/files/2026-05/Lightning_Safety_Guide_508_05122026.pdf), [NCAA](https://ncaaorg.s3.amazonaws.com/championships/resources/common/2024-25NCAAChamp_BestPracticesVenueSafetySecurity.pdf)).
23. **DOM-23** Take HeatRisk (spectators) and WBGT (staff) as inputs labelled as forecasts; any effect on medical demand is an assumption ([NWS](https://www.weather.gov/safety/heat-tools), [Grundstein](https://pmc.ncbi.nlm.nih.gov/articles/PMC5800727/)).
24. **DOM-24** Make evacuation, shelter in place (with concourse capacity) and relocation first-class plan types. Guidance says to always consider sheltering in place ([DHS 2008](https://www.cisa.gov/sites/default/files/publications/evacuation-planning-guide-stadiums-508.pdf), [OSU](https://ohiostatebuckeyes.com/sports/2026/4/6/concert-emergency)).
25. **DOM-25** Score plans against hard constraints: pedestrian–vehicle separation, emergency lanes and the ambulance route to the Wexner ED ([CISA](https://www.cisa.gov/sites/default/files/2024-04/Vehicle_Incident_Prevention_and_Mitigation_Security_Guide_508_20240418.pdf), [Wexner](https://wexnermedical.osu.edu/patient-and-visitor-guide/osu-game-day-parking)).
26. **DOM-26** Report how many people queue outside screening, and for how long, as security exposure; crowded chokepoints are targets ([CISA](https://www.cisa.gov/sites/default/files/2024-04/Vehicle_Incident_Prevention_and_Mitigation_Security_Guide_508_20240418.pdf), [bag guide](https://www.cisa.gov/sites/default/files/2026-08/FINAL_Public_Venue_Bag_Search_Procedures_AUG2026_508.pdf)).
27. **DOM-27** Check staffing against the 1:250 crowd-manager baseline, with room for deviations the AHJ approves; this staffing is required by code in Ohio ([IFC](https://up.codes/s/crowd-managers-for-gatherings-exceeding-1-000-people), [OFC](http://codes.ohio.gov/assets/laws/administrative-code/rules/1301/7/1301$7-7-04_eff_11_20_25.pdf)).
28. **DOM-28** Export GeoJSON/KML (closures, posts, zones), PDF and CSV, plus CAP 1.2 drafts that are never sent, so the work flows into ArcGIS, Everbridge or WebEOC ([Esri](https://doc.arcgis.com/en/arcgis-solutions/12.1/reference/introduction-to-special-event-operations.htm), [CAP](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.pdf)).
29. **DOM-29** Never dispatch, alert or launch incidents automatically. CAD, radio and notification belong to other systems ([Hexagon](https://blog.hexagon.com/managing-major-incidents-with-planning-response-technology/), [Everbridge](https://supportcenter.everbridge.com/hc/en-us/articles/54904609492123-VCC-How-Always-Alert-and-Auto-Incident-Control-Automatic-Alerts-and-Incidents-in-Visual-Command-Center)).
30. **DOM-30** Use ANSI INCITS 415 symbols, and give locations as gate, section and street with US National Grid references, which every agency recognises ([FGDC](https://www.fgdc.gov/hswg/ref_pages/SymbolFAQ_ref.htm), [NIMS](https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf)).
31. **DOM-31** Rank and rate-limit alerts, never rely on colour alone, and meet WCAG 2.2 contrast; overloaded operators miss alarms ([ISA-18.2](https://www.isa.org/getmedia/55b4210e-6cb2-4de4-89f8-2b5b6b46d954/PAS-Understanding-ISA-18-2.pdf), [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [MedlinePlus](https://medlineplus.gov/download/genetics/condition/color-vision-deficiency.pdf)).
32. **DOM-32** Provide separate views for planner, commander, controller and evaluator, as event-operations products do ([Esri](https://doc.arcgis.com/en/arcgis-solutions/12.1/reference/introduction-to-special-event-operations.htm), [HSEEP](https://www.fema.gov/sites/default/files/2020-04/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2-25.pdf)).
33. **DOM-33** Work fully offline on-device and produce print-ready output; command posts lose connectivity and IAPs circulate on paper ([NIMS](https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf), [Genasys](https://www.genasys.com/stadiums-and-events)).
34. **DOM-34** Never take in identity data, even if the venue uses facial-authentication entry; store zone-level counts only (hard rule; [DDN 2026](https://www.daytondailynews.com/sports/ohio-state-football-game-day-traffic-parking-and-other-tips-what-to-know/article_0a8256a5-d46b-5983-a93b-00e8edff0b00.html)).
35. **DOM-35** Show tradeoffs with uncertainty bands that may overlap, rank only by a priority the commander picks, and name the decision-maker. Decision-makers draw their own conclusions ([NASA-STD-7009B](https://standards.nasa.gov/sites/default/files/standards/NASA/B/1/NASA-STD-7009B-Final-3-5-2024.pdf), [CISA 2026](https://www.cisa.gov/sites/default/files/2026-05/Lightning_Safety_Guide_508_05122026.pdf)).

## Sources

**Crowd modelling and V&V**
- [Oasys MassMotion](https://www.oasys-software.com/products/massmotion/)
- [Huang et al., pedestrian LoS study (MDPI, 2026)](https://www.mdpi.com/2075-5309/16/16/3140)
- [Crossrail Whitechapel LEGION report](https://learninglegacy.crossrail.co.uk/wp-content/uploads/2018/06/Whitechapel-Station-Legion-Modelling-C140-HYD-Z-RGN-D061-00079-2.0.pdf)
- [Berrou et al., LEGION calibration and validation (2007)](https://link.springer.com/doi/10.1007/978-3-540-47064-9_15)
- Pathfinder: [V&V](https://www.thunderheadeng.com/docs/2024-1/pathfinder/verification-validation/), [NIST tests](https://www.thunderheadeng.com/docs/2025-1/pathfinder/appendices/verification-validation/nist/), [contours](https://www.thunderheadeng.com/docs/2026-1/results/viewing-pathfinder-output/occupant-contours/)
- [accu:rate crowd:it](https://www.accu-rate.de/en/crowdit/); [Kneidl et al., REMSY (PED 2025)](https://amca-admin.rachel.puxdesign.cz/PED25/media/amca/2025/abstrakta/ped_2025_extended_abstract_38.pdf)
- [JuPedSim docs](https://www.jupedsim.org/stable/), [JuPedSim repo](https://github.com/PedestrianDynamics/jupedsim), [Vadere](https://github.com/pedestrian-dynamics-HM/vadere), [PedPy](https://github.com/PedestrianDynamics/PedPy), [Jülich data archive](https://ped.fz-juelich.de/da/doku.php)
- G. K. Still: [RAMP](https://gkstill.com/Courses/elearning/Module05.html), [DIM-ICE](https://gkstill.com/Support/WhyModel/dimice.html), [event modelling](https://gkstill.com/Support/WhyModel/EventModelling.html), [Fruin LoS](https://www.gkstill.com/Support/crowd-flow/fruin/Fruin1.html)
- [Fruin, HRR 355 (1971)](https://onlinepubs.trb.org/Onlinepubs/hrr/1971/355/355-001.pdf); [Fruin, crowd disasters (1993)](https://gkstill.com/Support/crowd-flow/fruin/Fruin2.html); [Helbing et al. (2007)](https://arxiv.org/html/physics/0701203v2)
- [IMO MSC.1/Circ.1533 (2016)](https://www.deutsche-flagge.de/de/redaktion/dokumente/interpretationen/solas/ii-2/msc-1-circ-1533-revised-guidelines-on-evacuation-analysis-for-new-and-existing-passenger-ships.pdf); [RiMEA 4.1.1 (2025)](https://rimea.de/downloads/); [NIST TN 1822 (2013)](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.1822.pdf); [ISO 20414:2020](https://www.iso.org/standard/78348.html)

**Incident-command software**
- [Esri Special Event Operations](https://doc.arcgis.com/en/arcgis-solutions/12.1/reference/introduction-to-special-event-operations.htm)
- WebEOC: [IAP board](https://docs.juvare.com/webeoc-onnexa/board-list/board-incident-action-plan.htm), [Requests/Tasks](https://docs.juvare.com/webeoc-onnexa/board-list/board-requests-tasks.htm), [RID](https://docs.juvare.com/webeoc-onnexa/board-list/board-requests-inventory-and-deployments.htm)
- [Veoci TCU game day](https://veoci.com/blog/tcu-emergency-planning-game-day)
- Everbridge: [Visual Command Center](https://www.everbridge.com/products/visual-command-center/), [Auto Incident](https://supportcenter.everbridge.com/hc/en-us/articles/54904609492123-VCC-How-Always-Alert-and-Auto-Incident-Control-Automatic-Alerts-and-Incidents-in-Visual-Command-Center)
- [Genasys stadiums and events](https://www.genasys.com/stadiums-and-events)
- Hexagon: [HxGN OnCall P&R](https://sigblog.hexagon.com/hxgn-oncall-planning-response-the-best-asset-for-major-event-management/), [CAD scope (2019)](https://blog.hexagon.com/managing-major-incidents-with-planning-response-technology/)
- [Motorola CommandCentral Aware](https://www.motorolasolutions.com/content/dam/msi/docs/global-software/commandcentral-aware/cc_aware_brochure_web.pdf)

**Doctrine, codes and guidance**
- [NIMS 2017](https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf) (text read from the [FEMA EMI copy](https://training.fema.gov/emiweb/is/is700b/handouts/national_incident_management%20system_third%20edition_october_2017.pdf)); [IS-15.b](https://training.fema.gov/is/courseoverview.aspx?code=is-15.b&lang=en)
- [HSEEP 2020](https://www.fema.gov/sites/default/files/2020-04/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2-25.pdf) (text read from the [Oregon OEM copy](https://www.oregon.gov/oem/Documents/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2.pdf))
- NCS4: [Intercollegiate Best Practices (2015)](https://drulibrary.uoregon.edu/sites/default/files/rpds/entry/file_for_download/2015_NCS4_Intercollegiate_Best_Practices_Guide.pdf), [portal](https://ncs4.usm.edu/knowledgeportal/best-practices); [NCAA 2024-25 best practices](https://ncaaorg.s3.amazonaws.com/championships/resources/common/2024-25NCAAChamp_BestPracticesVenueSafetySecurity.pdf)
- CISA: [Lightning Safety Guide (2026)](https://www.cisa.gov/sites/default/files/2026-05/Lightning_Safety_Guide_508_05122026.pdf), [bag search (2026)](https://www.cisa.gov/sites/default/files/2026-08/FINAL_Public_Venue_Bag_Search_Procedures_AUG2026_508.pdf), [screening (2026)](https://www.cisa.gov/sites/default/files/2026-08/FINAL_Public_Venue_Security_Screening_AUG2026_508.pdf), [vehicle guide (2024)](https://www.cisa.gov/sites/default/files/2024-04/Vehicle_Incident_Prevention_and_Mitigation_Security_Guide_508_20240418.pdf), [Mass Gathering tool](https://www.cisa.gov/resources-tools/resources/mass-gathering-security-planning-tool)
- DHS: [Evacuation Planning Guide for Stadiums (2008)](https://www.cisa.gov/sites/default/files/publications/evacuation-planning-guide-stadiums-508.pdf), [SEAR fact sheet](https://www.dhs.gov/sites/default/files/publications/19_0905_ops_sear-fact-sheet.pdf)
- [NFPA Journal, Fall 2021](https://www.nfpa.org/News-and-Research/Publications-and-media/NFPA-Journal/2021/Fall-2021/In-Compliance/NFPA-101); [Ohio Fire Code 1301:7-7-04 (2025)](http://codes.ohio.gov/assets/laws/administrative-code/rules/1301/7/1301$7-7-04_eff_11_20_25.pdf)
- UpCodes: [IFC crowd managers](https://up.codes/s/crowd-managers-for-gatherings-exceeding-1-000-people), [IBC capacity](https://up.codes/s/required-capacity-based-on-occupant-load), [open-air seating](https://up.codes/s/open-air-assembly-seating), [smoke-protected seating](https://up.codes/s/smoke-protected-seating); [FP&C timed-egress letter (2023)](https://www.portlandoregon.gov/bds/appeals/index.cfm?action=getfile&appeal_id=31827&file_id=40845)
- SGSA: [Green Guide](https://sgsa.org.uk/green-guide/), [Worked Example A](https://sgsa.org.uk/wp-content/uploads/2024/02/Worked-Example-A-Football-and-Rugby.pdf), [circulation](https://sgsa.org.uk/physical-factors/circulation/), [Green Guide 7 consultation (2025)](https://sgsa.org.uk/wp-content/uploads/2025/05/Green-Guide-7-early-consultation.pdf); [East Suffolk on the Purple Guide](https://www.eastsuffolk.gov.uk/sites/default/files/2025-06/Guidance%20for%20planning%20an%20event%20and%20producing%20an%20Event%20Management%20Plan.pdf)
- [NWS heat tools](https://www.weather.gov/safety/heat-tools); [Grundstein et al.](https://pmc.ncbi.nlm.nih.gov/articles/PMC5800727/)

**Credibility and UX**
- [NASA-STD-7009B (2024)](https://standards.nasa.gov/sites/default/files/standards/NASA/B/1/NASA-STD-7009B-Final-3-5-2024.pdf); [ODD protocol (2020)](https://www.jasss.org/23/2/7.html); [AQuA Book](https://www.gov.uk/guidance/the-aqua-book); [NRC 2006](https://nap.nationalacademies.org/catalog/11699); [Endsley 1995](https://doi.org/10.1518/001872095779049543)
- [FGDC symbology](https://www.fgdc.gov/hswg/ref_pages/SymbolFAQ_ref.htm), [ANSI INCITS 415](https://webstore.ansi.org/standards/incits/incits4152006r2022); [CAP 1.2](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.pdf), [IPAWS profile](http://docs.oasis-open.org/emergency/cap/v1.2/ipaws-profile/v1.0/cap-v1.2-ipaws-profile-v1.0.pdf), [EDXL-SitRep](https://docs.oasis-open.org/emergency/edxl-sitrep/v1.0/cs02/edxl-sitrep-v1.0-cs02.pdf)
- [ISA-18.2 overview](https://www.isa.org/getmedia/55b4210e-6cb2-4de4-89f8-2b5b6b46d954/PAS-Understanding-ISA-18-2.pdf), [alarm floods (secondary)](http://www.digitalrefining.com/article/1000558,Alarm_floods_and_plant_incidents_.html); [WCAG 2.2](https://www.w3.org/TR/WCAG22/); [MedlinePlus](https://medlineplus.gov/download/genetics/condition/color-vision-deficiency.pdf)

**Ohio Stadium**
- OSU Athletics: [stadium](https://ohiostatebuckeyes.com/sports/2023/7/6/ohio-stadium), [A–Z guide](https://ohiostatebuckeyes.com/sports/2022/4/11/az-guide), [event policies](https://ohiostatebuckeyes.com/sports/2018/8/1/ohio-stadium-event-policies), [concert safety (2026)](https://ohiostatebuckeyes.com/sports/2026/4/6/concert-emergency)
- OSU: [DPS](https://dps.osu.edu/golf-cart-event-access-pass), [TTM](https://ttm.osu.edu/football_saturdays), [Wexner](https://wexnermedical.osu.edu/patient-and-visitor-guide/osu-game-day-parking), [Emergency Management](https://emergency.osu.edu/), [President's office](http://president.osu.edu/story/commitment-safety-well-being), [Student Conduct](https://u.osu.edu/studentconduct/2022/08/18/game-day-keeping-out-of-handcuffs/)
- Press: [Dayton Daily News (Sept 2026)](https://www.daytondailynews.com/sports/ohio-state-football-game-day-traffic-parking-and-other-tips-what-to-know/article_0a8256a5-d46b-5983-a93b-00e8edff0b00.html), [Athletic Business (2017)](https://www.athleticbusiness.com/operations/safety-security/news/15148417/complex-security-at-ohio-state-michigan-game), [NBC4 (Aug 2025)](https://www.nbc4i.com/news/local-news/ohio-state-university/ohio-state-police-increases-security-ahead-of-saturdays-big-game/)

**Repository:** [`engine/src/movement-flow.ts`](../../engine/src/movement-flow.ts) (`RHO_JAM`, `MAX_DOTS_PER_CELL`); the [`README.md`](../../README.md) demo table.

Content was rephrased for compliance with licensing restrictions.
