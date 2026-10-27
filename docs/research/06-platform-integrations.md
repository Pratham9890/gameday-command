# 06 — Platform integrations: everything around the simulation

> Gameday Command v3 research, brief items 4 and 8. Researched 26 Oct 2026; sources at the end. Engineering recommendations only, **not legal advice**: records, public-records and CJIS questions belong to the agency's counsel, records officer and CJIS contact.

## Summary

Today the product is a single-user demo. The Vercel build answers decisions only from the shipped cache, writes briefings only from a template and drops every write; the full experience needs one Mac running the Hono + `node:sqlite` server and two Apple-only local models. There are no accounts, no audit trail and no multi-user sync — officer mode is a role switch inside one tab (`roles.ts`, `DemoAccess.tsx`) — and the server fetches any URL a client posts to `/api/conditions/fetch`.

Agencies will judge v3 on the platform as much as the engine: running inside their network, or on a laptop when 100,000 phones saturate the cell sites; keeping Criminal Justice Information (CJI) out so CJIS never attaches; agency sign-in with MFA; an audit record for every plan edit, export and video-feed view; the ICS, Event Action Plan and HSEEP documents commanders already use; and every number saying whether it is simulated, observed, estimated or assumed.

**Recommendation.** One server artefact (container image and single executable) serving the PWA, a REST API, a WebSocket hub over an append-only event log, SQLite, local vector tiles and optional local-model adapters, in three modes: *solo laptop* (tabletop, air-gapped), *command-post LAN* (game day, internet optional) and *agency-hosted* (on-prem or the agency's own government-cloud tenancy). Feeds (NWS, ODOT OHGO, GOES lightning) are fetched server-side, cached, labelled with source and age, and never required. Vercel stays a synthetic-data demo. Requirements PLT-01…PLT-50 close the gaps.

## 1. Deployment models

| Model | Where it fits | Implication |
|---|---|---|
| Agency-hosted, on-prem | Police IT runs it behind its firewall under agency policy (in Ohio, LEADS policy sits on top of the FBI's for CJIS systems — [LEADS manual ch. 13](https://leads.ohio.gov/Documents/Manuals/LEADSManual/13%20Security%20Policy%20-%202026.pdf)) | Container, documented ports and paths, backups, SSO, no outbound calls required |
| Agency government-cloud tenancy | The agency's own GovCloud/Azure Government subscription; provider CJIS agreements go state by state, and Microsoft lists Ohio among five states where it has no CJIS Management Agreement ([Microsoft](https://learn.microsoft.com/en-us/azure/compliance/offerings/offering-cjis)) | Same image, agency-held keys; we never operate it |
| Vendor SaaS | Buyers require FedRAMP or GovRAMP (formerly StateRAMP) status, both built on NIST SP 800-53 ([FedRAMP](https://www.fedramp.gov/marketplace/guide/), [GovRAMP](https://govramp.org/faqs)) | Out of scope for v3 |
| Air-gapped laptop | HSEEP tabletops are facilitated discussions around a Situation Manual ([HSEEP 2020](https://www.fema.gov/sites/default/files/2020-04/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2-25.pdf)) | App, tiles, extracts, decision seed and PDF output all local |

Big crowds strain commercial cellular capacity — the reason FirstNet sends deployable cells to major sporting events ([PERF/FirstNet](https://www.policeforum.org/assets/FirstNetDeployables.pdf)); Green Bay police saw congestion peak during big plays ([FirstNet Authority](https://firstnet.gov/newsroom/blog/connecting-green-bay-law-enforcement-and-field)). The command post must work with no WAN.

**What today's setup implies.** Vercel (`vercel.json`) serves static files, seeded decisions (`api/decide.js`) and template briefings (`api/briefing.js`) and loses every write: a public demo, never a home for agency data. Kev (MLX) and `fm serve` are macOS/Apple-silicon tools (`.env.example`) while agency fleets are mostly Windows and Linux (assumption), so models must be optional; the server already falls back to defaults. It speaks plain HTTP on :8787 with no authentication, so on a LAN every route is open to anyone on the Wi-Fi.

## 2. Security and compliance

### 2.1 CJIS: designed not to apply
The CJIS Security Policy (v6.1, 25 Jun 2026 — [FBI](https://le.fbi.gov/file-repository/cjis_security_policy_v6-1_20260625.pdf/view)) protects CJI: FBI-CJIS-provided biometric, identity-history, person, organisation, property (with PII) and case/incident-history data ([Appendix A](https://le.fbi.gov/cjis-division/cjis-security-policy-resource-center/appendicies)). Gameday Command needs none of it: crowds are counts, officers are units and positions, incidents are scenario objects. **Rule:** store no CJI and no identity of any member of the public; no CAD, RMS or LEADS import; free-text fields warn against names, plates and case numbers and are left out of exports by default; integrations flow outward. Build to the CJIS bar anyway (MFA, audit, encryption), because agencies may run it on networks that carry CJI.

### 2.2 Identity, MFA and sessions
- **Local accounts** (solo/LAN): Node's built-in scrypt for passwords; passkeys ([WebAuthn](https://www.w3.org/TR/webauthn-3/)) or TOTP as second factor.
- **Agency SSO**: [OpenID Connect](https://openid.net/specs/openid-connect-core-1_0.html) and [SAML 2.0](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf), IdP groups mapped to positions (`openid-client`, `@node-saml/node-saml`, `@simplewebauthn/server`, all MIT).
- **NIST SP 800-63B-4**: AAL2 needs two factors and must offer a phishing-resistant option; reauthenticate at least every 24 h and after ≤1 h idle (AAL3: 12 h/15 min) ([NIST](https://pages.nist.gov/800-63-4/sp800-63b/aal/)). Wallboards that must not lock mid-incident get revocable read-only *display grants* tied to a position and screen.
- Cookies `HttpOnly; Secure; SameSite=Strict`, rotated at sign-in, server-side sessions, WebSockets bound to the session with an Origin check ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)).

### 2.3 Roles matched to ICS positions
In WebEOC users sign in to a *position* and an *incident*, privileges attach to positions, and separate input and display views keep sensitive fields need-to-know ([Juvare](https://docs.juvare.com/webeoc-onnexa/webeoc-nexus-key-concepts.htm)). v3 does the same per event or exercise:

| Position | Can |
|---|---|
| Incident/Event Commander, Unified Command | approve plan versions, issue simulated orders, see all |
| Planning Section Chief / Situation Unit | scenarios, plans, comparisons, IAP; 201/202/209 |
| Operations Section Chief | tactics (215), assignments (204) |
| Branch/Division/Group Supervisor · Field unit | own assignments, acknowledge, status, report |
| Safety Officer · Weather monitor · Comms Unit Leader · Medical Unit Leader · PIO | 208/215A · lightning/weather thresholds · 205/205A · 206 · draft public messages |
| Exercise Director, Controller, Evaluator, Trusted Agent, Player, Observer | release injects, record observations, see or hide the scenario |
| Records custodian · System admin | retention, holds, audit · accounts and IdP only, no operational content |

Form ownership follows FEMA: e.g. the Communications Unit Leader assigns talkgroups on the 205, and the Resources Unit builds 204s from the Operations Section Chief's 215 ([FEMA](https://training.fema.gov/emiweb/is/icsresource/assets/ics%20forms%20descriptions.pdf)).

### 2.4 Audit logging
Two append-only logs. The **event log** (orders, assignments, acknowledgements, plan edits, approvals, injects) is the operational record behind ICS 214s and the AAR. The **security audit log** records sign-ins and failures, grant changes, restricted-annex views, video-feed views (start/stop), exports and prints, feed configuration and retention actions — who (user, position), what, when (server time), device, outcome ([OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)). Hash-chain entries and sign periodic checkpoints so tampering shows, in the spirit of NIST SP 800-53 AU-9/AU-10 ([NIST](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final)). Never log secrets, tokens or frames.

### 2.5 Data classification and encryption

| Class | Examples | Handling |
|---|---|---|
| Public · Internal | OSM base map, demo scenarios · training scenarios, templates | attribution · signed-in users |
| Restricted | officer posts and staffing, suspicious-package response plans, 205/205A, camera locations | need-to-know, marked, every view and export audited |
| Staff personal | names on 203/204, phones on 205A, accounts | agency deployments only, minimal |
| Prohibited | CJI; faces, identities or plates of the public; stored video frames (default) | rejected by schema |

TLS 1.2+ with 1.3 supported (the bar NIST SP 800-52 Rev. 2 sets for government servers — [NIST](https://csrc.nist.gov/pubs/sp/800/52/r2/final)) for HTTP and WebSocket in every mode, which service workers need anyway: they run only in secure contexts, localhost excepted ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)); on a LAN use the agency CA or a local CA (e.g. mkcert, BSD-3-Clause) on managed devices. At rest: full-disk encryption on every machine, encrypted backups, and SQLCipher (BSD-3-Clause) only if per-file keys are required (`node:sqlite` ships stock SQLite, so that means another driver). Secrets (OHGO key, OIDC secret, session keys) stay server-side; `.env.example`'s "nothing here is secret" stops being true.

### 2.6 Ohio public records and retention (context only)
- Ohio "records" are items in any form, created or received by a public office, that document its functions, decisions or operations ([ORC 149.011](https://codes.ohio.gov/ohio-revised-code/section-149.011)); public records must be produced unless exempt ([ORC 149.43](https://codes.ohio.gov/ohio-revised-code/section-149.43)). Ohio State runs its own programme under ORC 149.33(B) ([OSU](http://go.osu.edu/records)).
- [ORC 149.433](https://codes.ohio.gov/orc/149.433) exempts *security records* — including specific response plans meant to prevent or mitigate terrorism and "deployment plans of law enforcement or emergency response personnel" — and *infrastructure records*. Whether a plan qualifies is counsel's call; the app keeps deployment and comms annexes separable so withholding is a selection, not an edit.
- Retention follows the agency's approved schedule. Examples: the Columbus Division of Police schedule (2023) keeps the master copy of *Special Event/Activity Plans* 2 years from the event, series 94-31 ([Columbus](https://www.columbus.gov/files/sharedassets/city/v/1/public-safety/police/divisionofpoliceretentionschedule2023update.pdf)); Ohio's suggested general schedule keeps training materials until superseded and backups for one backup cycle ([Ohio History Connection](https://www.ohiohistory.org/research/local-government-records-program/local-retention-schedules-forms/general-schedule-draft-2022/)). So retention is configuration per record type, with legal holds and a disposal list.
- The Attorney General's 2026 Sunshine Laws manual warns against auto-deleting messaging tools for public business ([Ohio AG](https://www.ohioattorneygeneral.gov/Media/News-Releases/March-2026/AG-Yost-Releases-2026-Yellow-Book-Provides-Guidanc)); in-app messages and acknowledgements are kept like other records.

### 2.7 Gaps in today's server
- `POST /api/conditions/fetch` fetches any http(s) URL: server-side request forgery on a LAN (it reaches `127.0.0.1:8009`, routers, metadata endpoints). Replace with allowlisted feeds.
- No authentication; `POST /api/plans` does `insert or replace` on a client-chosen id — silent overwrite, no author, no version.
- `/api/stadiums/search` proxies public Nominatim with no cache or app-wide throttle and a User-Agent without contact.
- The localStorage role in `roles.ts` is a UI preference, not access control.

## 3. Multi-user collaboration

**Event log.** One server-authoritative, append-only log per event or exercise; state is a fold over events, so any past moment can be rebuilt ([Fowler](https://martinfowler.com/eaaDev/EventSourcing.html)). Commands are validated, given the next `seq`, stored and broadcast. Envelope: `id` (client UUIDv7, also the idempotency key), `seq`, `stream` (event + operational period), `type`, `actor {user, position}`, `clientTime`, `serverTime`, `simTime`, `causedBy`, `mode` (`planning | exercise | demo`), `payload`. Types include `assignment.created/acknowledged`, `unit.status`, `order.simulated` (today's `PoliceOrder` from `engine/src/edits.ts`), `plan.approved`, `inject.released` and `feed.viewed`; the same log drives the simulation, the `after-action.ts` timeline and the AAR.

**Transport and presence.** WebSocket ([RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455)) via `@hono/node-server`'s built-in upgrade with `ws` (MIT) ([Hono](https://hono.dev/docs/helpers/websocket)); reconnect replays `since=<seq>`; a 15 s heartbeat (assumption) shows who holds each position and when field units were last heard. No GPS tracking of officers: status is reported, not tracked.

**Conflicts.** No generic CRDT for orders: one owner position per ICS form or section; compare-and-set with `expectedVersion` on assignments (if a unit was reassigned meanwhile the server refuses and the UI shows both); idempotent acknowledgements; Yjs or Automerge (both MIT) only if shared free-text notes are ever needed.

**Offline queue.** Field devices keep an IndexedDB outbox keyed by event id, flushed on reconnect, app start and `online`; Background Sync helps only on Chromium ([caniuse](https://caniuse.com/background-sync)). The UI separates *queued*, *delivered (seq n)* and *acknowledged* and never shows an unsent acknowledgement as received; an expired session keeps the outbox until sign-in.

**Replacing "Demo radio sync".** First BroadcastChannel between windows on one machine (projector + controller) in solo mode — the gap in `CHECK THIS.MD` item 6 — then the WebSocket hub, carrying the same event types.

**Bandwidth.** One frame's density grid is 640k Float32 values (about 2.56 MB), so simulations run on the command-post machine and field devices get assignments and per-zone summaries (target ≤50 KB/min — assumption to measure). Runs are deterministic: another laptop can recompute a plan from seed + tape instead of receiving frames.

## 4. Integrations and real data feeds

Every feed runs through a server adapter: allowlisted host, identifying User-Agent with contact, HTTP caching, size and time limits, output `{source, observedAt, fetchedAt, licence}` with a staleness threshold. Missing data is "unknown", never zero, as `conditions.ts` already does.

| Feed | Access and terms | Use in v3 |
|---|---|---|
| **NWS API** | Free, no key; unique User-Agent with contact required; undisclosed rate limit, retry after ~5 s; GeoJSON/JSON-LD/CAP ([NWS](https://www.weather.gov/documentation/services-web-api)). Checked 26 Oct 2026: the stadium is office ILN grid 84,83, zone OHZ055, county OHC049, stations KOSU/KCMH; `/points` cached 24 h; CORS open | Point alerts (CAP), hourly forecast, observations — labelled *observed/forecast*, apart from scenario weather |
| **Lightning** | Not in NWS API. NLDN is sold by Vaisala ([NCEI](https://www.ncei.noaa.gov/products/lightning-products)); Blitzortung bans commercial and storm-warning use ([Blitzortung](https://www.blitzortung.org/en/contact.php?lang=en)) — excluded. Free: GOES-R GLM total lightning, ~10 km resolution ([NCEI](https://www.ncei.noaa.gov/products/goes-terrestrial-weather-abi-glm)), 20 s files ([NOAA](https://repository.library.noaa.gov/view/noaa/49140/noaa_49140_DS1.html)), latency requirement <20 s ([NOAA](https://origin-east-01-www-ospo.woc.noaa.gov/operations/goes/product-quality-overview/ps-pvr/goes-16/GLM/Full/GOES16_GLM_FullValidation_ProductPerformanceGuide.pdf)); GOES-19 is GOES-East on AWS open data ([AWS](https://registry.opendata.aws/noaa-goes/)) | GLM flashes labelled "satellite, coarse"; agency detection service via import. NCAA venue guidance uses 30/12/8-mile tiers, adjusted per venue ([NCAA](https://ncaaorg.s3.amazonaws.com/championships/resources/common/2024-25NCAAChamp_BestPracticesVenueSafetySecurity.pdf)); NATA advises waiting 30 min after the last strike or thunder ([NATA](https://www.nata.org/press-release/nata-provides-guidelines-lightning-safety)). Tiers are agency settings shown as information; ~10 km pixels make an 8-mile ring indicative |
| **ODOT OHGO** | Free key after email registration, on every request; per-key limit (25 req/s as an example, subject to change); ODOT may revoke without notice; as-is; ODOT calls the data public domain ([terms](https://publicapi.ohgo.com/docs/terms-of-use), [API](https://publicapi.ohgo.com/)) | Incidents, closures, construction, delays, signs; key server-side; camera images only via the video lane's counts-only pipeline |
| **Signals** | No public live Columbus/ODOT feed found. Timing plans, controller logs ([FHWA](https://ops.fhwa.dot.gov/arterial_mgmt/performance_measures.htm)) and SPaT/MAP ([FHWA V2X Hub](https://highways.dot.gov/sites/fhwa.dot.gov/files/FHWA-HRT-22-047.pdf)) are agency-held | Data-sharing agreement; import timing files; never control signals |
| **Nominatim** | Absolute max 1 request/s for the whole app, identifying UA, attribution, ODbL, no autocomplete, cached results, endpoint switchable without an update, periodic use discouraged ([policy](https://operations.osmfoundation.org/policies/nominatim/)). Today: explicit search and env-set URL comply | Admin-only import, app-wide throttle and cache; self-hosted for agencies |
| **Overpass** | Roughly ≤10,000 queries and ≤1 GB per day ([Overpass](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)) | Import once; extract stored (done) |
| **OSM tiles** | No bulk download or prefetch; attribution, UA and caching required ([tile policy](https://operations.osmfoundation.org/policies/tiles/)) | Not used: Planetiler (Apache-2.0) builds PMTiles (BSD-3-Clause) from an extract for MapLibre (BSD-3-Clause); attribution on screen and exports ([OSMF](https://wiki.osmfoundation.org/wiki/Attribution_Guidelines)); agency layers apart from OSM-derived ones ([OSMF](https://osmfoundation.org/wiki/Community_Guidelines/Horizontal_Map_Layers_-_Guideline)) |
| **Gate scans** | Ticketmaster's Presence API serves scanning partners ([Ticketmaster](https://developer.ticketmaster.com/products-and-docs/apis/presence/)) — assume private | Import contract |
| **Parking** | Operator-held; APDS model, adopted as ISO/TS 5206-1:2023 ([ISO](https://www.iso.org/standard/80997.html), [IPMI](https://www.parking-mobility.org/news/iso-formally-adopts-global-parking-data-specification-based-on-alliance-for-parking-data-standards-data-specification/)) | Import contract |
| **CAD/RMS** | NIEM is now NIEMOpen at OASIS ([Model 6.0](https://docs.oasis-open.org/niemopen/niem-model/v6.0/niem-model-v6.0.pdf)); APCO/NENA EIDD (NIEM XML) and NENA's ANSI EIDO (JSON) carry incidents between CADs ([EIDD](https://www.nena.org/?page=EIDD_INF), [EIDO](https://www.nena.org/news/584569/NENA-Releases-ANSI-Approved-Emergency-Incident-Data-Object-EIDO-Standard.htm)) | No live link (CJI risk; not a CAD); name export fields after EIDO |
| **CAP** | CAP 1.2 `status`: Actual, Exercise (designated participants; exercise id in `note`), System, Test, Draft ([OASIS](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html)) | Read NWS CAP; write only Draft or Exercise |
| **IPAWS/WEA** | Alerting authorities only: FEMA sign-up, IS-247, agency-procured compatible software; FEMA does not review alerts ([FEMA](https://www.fema.gov/emergency-managers/practitioners/integrated-public-alert-warning-system/public-safety-officials/sign-up), [IPAWS 101](https://www.fema.gov/sites/default/files/documents/fema_ipaws_101-slicksheet_042024.pdf)) | Hand-off: draft CAP file and text for the agency's originator |
| **Radio** | MARCS: statewide 700/800 MHz trunked network run by Ohio DAS ([DAS](https://das.ohio.gov/technology-and-strategy/marcs/07-MARCS)), P25 ([DAS](https://dam.assets.ohio.gov/image/upload/das.ohio.gov/technology-strategy/marcs/MPP%2014%20System%20Programming%20Keys%20-%201_11_2021.pdf)); interconnects need ISSI/CSSI engineering ([CISA](https://www.cisa.gov/sites/default/files/publications/20190130%20ISSI-CSSI%20Primer%20FINAL%20508C.pdf)) | Out of scope: a training tool must never sit in a mission-critical voice path, and talkgroup plans are sensitive (149.433 lists "communication codes"); render the 205 from agency data |
| **GIS out** | GeoJSON ([RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946), WGS 84 lon/lat), [KML 2.3](https://ogc.org/standards/kml/), [GeoPackage](https://www.geopackage.org/spec/); Esri `applyEdits` to an agency service ([Esri](https://developers.arcgis.com/rest/services-reference/enterprise/apply-edits-feature-service-layer/)); free government TAK reads KML/CoT ([TAK.gov](https://tak.gov/products)) — ATAK-CIV code is [GPL-3.0](https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV), so formats only | Export via the inverse of `makeProjection` (MapBundle has no lat/lon) |

**Import contract** `gameday.observations/1.0.0` (extends `conditions.ts`): CSV or JSON, one aggregate reading per row — `source`, `observedAt` (RFC 3339 with offset), `intervalS`, `kind` (`gate_scans | gate_queue | lot_occupancy | street_stopped | lightning | other`), `subject`, `value`, `unit`, `method` (`scanner | sensor | manual | estimate`), optional `uncertainty`. Rows with ticket barcodes, account ids, plates or per-person data fail validation.

## 5. Products the app must output
- **IAP/EAP per operational period:** ICS 201 (FEMA: also the permanent record of the initial response), 202, 203, 204 per division/group, 205/205A, 206, 207, 208, with 215/215A worksheets and a map ([FEMA forms](https://training.fema.gov/emiweb/is/icsresource/assets/ics%20forms%20descriptions.pdf)); FEMA publishes fillable PDFs ([ICS Resource Center](https://training.fema.gov/emiweb/is/icsresource/)); planned-event content per [IS-15.b](https://training.fema.gov/is/courseoverview.aspx?code=is-15.b&lang=en). From the event log: an ICS 214 per position (FEMA: a reference for any AAR) and 209 snapshots.
- **HSEEP:** ExPlan (with *assumptions and artificialities*), SitMan, MSEL (event number, scenario time, type, inject mode, from, to, message, expected response, objective, notes; inject/contingency inject/expected action), controller/evaluator handbook, EEGs, feedback forms, hotwash notes, AAR/IP with corrective actions ([HSEEP 2020](https://www.fema.gov/sites/default/files/2020-04/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2-25.pdf)).
- **Briefings and data:** 16:9 slides, one-pagers, GIS layers, CAP drafts, and a **simulation annex** (scorecards, assumptions, seed, tape hash, engine version, fallbacks) kept apart from the approved plan.
- **PDF without a paid service:** HTML + print CSS via the browser's print-to-PDF — no dependency, offline, any laptop (`afterActionHtml` already works this way); headless Chromium through `playwright-core` (Apache-2.0) for unattended batches; pdf-lib (MIT) to fill FEMA's fillable PDFs. Optional: Paged.js (MIT) for running headers and page X of Y, PptxGenJS (MIT) for PowerPoint, Typst (Apache-2.0) if the server moves to Rust.

## 6. Operational resilience
- **Offline-first PWA:** precache shell and engine, cache API GETs, serve local PMTiles by HTTP range, request `navigator.storage.persist()`. Best-effort storage can be evicted, and Safari deletes script-written data after 7 days without interaction when tracking prevention is on ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)) — so the pre-event checklist opens every field device that week and verifies its offline pack.
- **Local-first:** the command-post server holds the log, clients hold replicas, and the edge log uploads to the agency server afterwards, merged by event id ([Ink & Switch](https://www.inkandswitch.com/essay/local-first/)).
- **Battery and heat:** three simulation workers plus a 3D map is a sustained load (assumption — measure it). Where the Compute Pressure API exists, step down sim speed, pause hidden plans and cut frame rate as `thermals`/`cpu` rise from nominal to critical ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Compute_Pressure_API)); offer a manual saver, hold a wake lock on wallboards, run the command post on mains power.
- **Crash recovery:** SQLite WAL; draft edits autosaved to IndexedDB on each change; engine snapshots persisted every 5 sim-minutes (assumption). Same seed + tape = same run, so recovery is scenario + tape + latest snapshot; clients resync from their last `seq`.
- **Time:** the server is the clock; clients estimate offset with an NTP-style four-timestamp ping ([RFC 5905](https://datatracker.ietf.org/doc/html/rfc5905)); ordering uses `seq`, never client clocks ([Kleppmann](https://www.cl.cam.ac.uk/teaching/2223/ConcDisSys/dist-sys-notes.pdf)); warn above 2 s skew (assumption). Store UTC plus `America/New_York`; export RFC 3339 with offsets (CAP writes UTC as `-00:00`, never `Z`). Label game clock and wall clock everywhere.
- **Budgets:** INP ≤200 ms at p75 ([web.dev](https://web.dev/articles/inp)); 16 ms frames for map interaction ([RAIL](https://developers.google.com/web/fundamentals/performance/rail)), 30 fps floor (assumption); ≥10× real time per plan with three plans (GOAL.md bar; README measured 56.8×); LAN fan-out ≤1 s and cold start ≤5 s (assumptions).

## 7. Quality and release
Test pyramid ([Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html)), all in CI:
1. **Engine V&V:** verification unit tests; determinism (equal frame hashes for seed + tape across runs and browsers); validation cases modelled on [ISO 20414](https://www.iso.org/standard/78348.html), [NIST TN 1822](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.1822.pdf) and [RiMEA](https://rimea.de/) plus fundamental-diagram tests — commercial egress tools publish such a report each release ([Pathfinder](https://www.thunderheadeng.com/docs/2024-1/pathfinder/verification-validation/)).
2. **Contract:** JSON Schema for every route, event type and file; golden files; old-version fixtures must still load.
3. **Integration:** server + SQLite + WebSocket under dropped links, duplicates, compare-and-set conflicts and clock skew.
4. **End-to-end:** Playwright (Apache-2.0), separate contexts for commander, Ops chief, two field units and a controller, with offline toggles.
5. **Visual regression:** screenshots on fixed seeds (determinism keeps them stable).
6. **Accessibility:** axe-core and `@axe-core/playwright` (MPL-2.0, dev-only) against WCAG 2.1 AA, the DOJ Title II standard, whose deadlines an April 2026 interim final rule moved to 26 Apr 2027 (population ≥50,000) and 26 Apr 2028 ([ADA.gov](https://www.ada.gov/resources/2024-03-08-web-rule/), [Federal Register](https://public-inspection.federalregister.gov/2026-07663.pdf)); plus manual keyboard and screen-reader passes.

**Versioning and supply chain.** [SemVer 2.0.0](https://semver.org/) for the data contract and each file schema (MAJOR = incompatible) instead of one `CONTRACT_VERSION` string; scenario files carry schema version, engine version, seed and tape hash; migrations are tested on fixtures. Releases ship an SBOM, pass a licence check (allow MIT/BSD/Apache-2.0/ISC/MPL-2.0; flag GPL/AGPL/non-commercial) and are signed. **Telemetry** is off by default; if enabled it stays on the agency server with counts, timings and crash signatures only — no user ids, IPs, free text or unit positions (OpenTelemetry, Apache-2.0, to an agency collector).

## 8. Product scope and labelling
The start screen, About page and every product footer say:
- **Not** CAD or dispatch, radio, mass notification, RMS or surveillance.
- **Not a forecast** unless calibrated: fan behaviour is an assumption and `docs/forecast.md` sets the claim rules. Professional egress software says the same — Pathfinder warns its model may or may not predict a real situation and its results need a competent user ([Pathfinder V&V](https://files.thunderheadeng.com/support/files/verification_validation_2019_2.pdf)).
- **Not evidence:** no chain of custody; video numbers are estimates. Outputs may still be public records (§2.6).

**Labels.** Every number carries `provenance` (`simulated | observed | estimated | assumed | default`), `source`, `asOf` and, when estimated, `uncertainty`; exported metadata uses W3C PROV-O terms such as `wasGeneratedBy` ([W3C](https://www.w3.org/TR/prov-o/)). Products carry "SIMULATION — NOT OBSERVED DATA" or "EXERCISE" banners; CAP uses `Exercise`; GeoJSON features carry `provenance, runId, seed, engineVersion, tapeHash`. Observed and simulated values never share a series without a legend.

## 9. How professional tools of this kind work — and what v3 copies

| Practice | Seen in | v3 |
|---|---|---|
| Sign in to a position and an incident; need-to-know views | WebEOC ([Juvare](https://docs.juvare.com/webeoc-onnexa/webeoc-nexus-key-concepts.htm)) | PLT-08 |
| Plan per operational period: objectives → tactics → assignments → approval → briefing → execute → assess (the Planning P) | ICS 300 ([FEMA](https://training.fema.gov/emiweb/is/icsresource/assets/incident%20action%20planning%20process.pdf)) | PLT-30 |
| Plain language and common terminology | NIMS ([FEMA](https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf), [CISA](https://www.cisa.gov/sites/default/files/publications/Making%20the%20transition%20form%2010codes%20to%20plain%20language.pdf)) | PLT-49: ICS titles, 24-hour times, no "Kev" or "dots" in products |
| Control separate from evaluation; MSEL injects; trusted agents; hotwash; AAR/IP with tracked corrective actions | [HSEEP 2020](https://www.fema.gov/sites/default/files/2020-04/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2-25.pdf) | PLT-35, PLT-48 |
| Tabletop ≥30 days before a championship with findings and agreements recorded; a named weather monitor | NCAA guide built on NCS4 ([NCAA](https://ncaaorg.s3.amazonaws.com/championships/resources/common/2024-25NCAAChamp_BestPracticesVenueSafetySecurity.pdf)) | PLT-26, PLT-35 |
| Shared map through TAK, free government software agencies already run | [TAK.gov](https://tak.gov/products), [DHS](https://www.dhs.gov/sites/default/files/publications/5298_tak_factsheet_2020_v2.pdf) | PLT-32: export KML/CoT, no tracking app of our own |
| Published V&V and honest limits | [Pathfinder](https://www.thunderheadeng.com/docs/2024-1/pathfinder/verification-validation/) | PLT-43 |

## Recommended platform architecture (v3)

```
 Browsers (PWA)                     gameday-server: one process, one data directory
 ┌───────────────────────┐  HTTPS  ┌───────────────────────────────────────────────────────┐
 │ commander and chiefs  │◄───────►│ static PWA + service worker · PMTiles by HTTP range   │
 │ engine workers (WASM) │   WSS   │ REST /api/v3 (OpenAPI + JSON Schema)                  │
 │ field lite client     │◄───────►│ WS hub: event log (seq) · presence · replay since seq │
 │ controller console    │         │ auth: local · OIDC · SAML · passkeys/TOTP · positions │
 └───────────────────────┘         │ audit log (hash chain) · retention · export renderer  │
   BroadcastChannel (solo)         │ feed adapters: NWS · OHGO · GLM · imports (allowlist) │
                                   │ model adapters (optional): cache → Kev → defaults     │
                                   │ SQLite (WAL) + files: scenarios, extracts, products   │
                                   └───────────────────────────────────────────────────────┘
```

- **Components:** browser PWA (commander and chief screens, field lite client, exercise controller console) with the engine in workers, plus one server. Keep TypeScript + Hono + `node:sqlite` (today's stack, no native build), shipped as an OCI image and a Node single executable application (Node 25.5 added `--build-sea` — [Node.js](https://nodejs.org/en/blog/release/v25.5.0)). The simulation stays client-side, so the engine rewrite does not touch the server.
- **Data stores (SQLite):** `events` (seq, id, stream, type, actor, times, mode, payload, prev_hash, hash), `audit`, `users`/`positions`/`grants`/`sessions`, `scenarios` and `plans` (versioned; approved = immutable), `products` (file + hash), `observations`, `decision_cache`, `retention_classes`/`holds`; blobs on disk.
- **APIs, auth, sync, offline:** REST for documents and exports, WebSocket for events and presence, published schemas; auth per §2.2, sync per §3, offline per §6.
- **Deployment:** *A — solo laptop* at `https://localhost`, no network. *B — command-post LAN*: the laptop or a small PC serves a closed Wi-Fi/Ethernet LAN with an agency or local CA; any uplink (FirstNet, wired) only feeds the adapters. *C — agency-hosted*: the container behind the agency's proxy and IdP, with backups; B nodes upload their logs afterwards. Vercel: public demo only.

**New dependencies proposed** (licences checked on GitHub, 26 Oct 2026). MIT: `ws`, `openid-client`, `@node-saml/node-saml`, `@simplewebauthn/server`, pdf-lib, Paged.js (opt.), PptxGenJS (opt.), Yjs/Automerge (opt.). BSD-3-Clause: MapLibre GL JS, PMTiles, SQLCipher (opt.), mkcert (tool). Apache-2.0: Planetiler (build tool), Playwright, OpenTelemetry JS (opt.), Typst (opt.). MPL-2.0: axe-core, `@axe-core/playwright` (dev only). **Flagged:** OSM data is ODbL (share-alike for derived databases); ATAK-CIV is GPL-3.0 (formats only, no code); Blitzortung is non-commercial (excluded); NLDN is commercial (only if the agency supplies it).

## Requirements

**Deployment**
- **PLT-01** One artefact (OCI image + single executable) serves PWA, REST, WebSocket, tiles and SQLite; no external service needed.
- **PLT-02** Solo, command-post-LAN and agency-hosted modes by configuration; ports, paths, backup and restore documented.
- **PLT-03** Every core function works with zero internet; feeds optional, shown stale or absent.
- **PLT-04** Local models are optional loopback adapters; defaults and shipped seed work on Windows, macOS, Linux; model licences recorded.
- **PLT-05** Vercel build labelled "public demo — synthetic data": no accounts, no agency data.

**Security and records**
- **PLT-06** No CJI: no person, plate, criminal-history or case-person fields; no CAD/RMS/LEADS ingest; free text warned and kept out of exports.
- **PLT-07** Local accounts, OIDC and SAML 2.0 SSO; MFA with passkeys offered, TOTP fallback.
- **PLT-08** Position-based access per event/exercise (ICS staff, divisions, field units, safety/weather/comms/medical/PIO, HSEEP roles, records, admin).
- **PLT-09** AAL2 sessions (≤24 h, ≤1 h idle), hardened cookies, revocation closing sockets; revocable read-only display grants.
- **PLT-10** Hash-chained, append-only security audit log with signed checkpoints (sign-ins, grants, restricted and video-feed views, exports, retention).
- **PLT-11** TLS 1.2+ with 1.3 supported for HTTP and WebSocket in every mode, via agency or local CA.
- **PLT-12** Full-disk encryption prerequisite; encrypted backups; field devices hold only their slice, cleared at sign-out.
- **PLT-13** Classification label on every record and product; restricted annexes separable for withholding.
- **PLT-14** Outbound requests only to an admin allowlist, private/loopback blocked, size/time limited (replaces `/api/conditions/fetch`).
- **PLT-15** Secrets server-side only, never in bundle or repo; rotation documented.
- **PLT-16** Retention class per record type, legal holds, disposal list; no hard-coded periods; no ephemeral messages.
- **PLT-17** Public-records package withholds chosen annexes with a manifest and agency-entered basis; sources untouched.

**Collaboration**
- **PLT-18** Append-only event log: server `seq`, idempotent client ids, actor (user + position), server/client/sim times, mode.
- **PLT-19** WebSocket hub with replay since `seq`, presence per position, heartbeat; same events over BroadcastChannel in solo mode.
- **PLT-20** One owner per ICS form; compare-and-set on assignments; idempotent acknowledgements; conflicts shown, never silently merged.
- **PLT-21** Field outbox with queued/delivered/acknowledged states, kept across session expiry.
- **PLT-22** Field clients get assignments and zone summaries within a measured budget (target ≤50 KB/min), never frames.
- **PLT-23** No GPS tracking of personnel in v3.

**Integrations**
- **PLT-24** Feed adapters: allowlist, identifying User-Agent, HTTP caching, backoff, provenance, staleness; unknown is never zero.
- **PLT-25** NWS alerts, hourly forecast and observations for the venue; `/points` re-resolved periodically.
- **PLT-26** Lightning from GOES GLM (labelled coarse) plus agency import; distance tiers are agency settings, shown as information.
- **PLT-27** OHGO adapter: server-held key, rate limit respected, terms recorded.
- **PLT-28** Observation import contract 1.0.0 (CSV/JSON, aggregates only, schema-validated), APDS-aligned for parking.
- **PLT-29** OSM compliance: no tile prefetch; local PMTiles; Nominatim ≤1 request/s app-wide, cached, switchable; attribution everywhere; agency layers separate.
- **PLT-30** Plan workflow follows the Planning P: draft → reviewed → approved; approved versions immutable.
- **PLT-31** CAP 1.2 only as Draft or Exercise, for hand-off; no alert sending, live CAD/RMS or radio link; 205 from agency data.
- **PLT-32** GIS export: GeoJSON, KML 2.3, GeoPackage, optional agency ArcGIS push; provenance on every feature.

**Products**
- **PLT-33** IAP/EAP PDF per operational period (201–208, 205A, 207, map) with prepared/approved by, version, page X of Y, classification and mode banners.
- **PLT-34** ICS 214 per position, 209 snapshots and timeline report from the event log.
- **PLT-35** HSEEP set: ExPlan, SitMan, MSEL, C/E handbook, EEGs, feedback form, hotwash notes, AAR/IP with corrective actions tracked across exercises.
- **PLT-36** PDF via HTML + print CSS, headless Chromium for batches, pdf-lib for FEMA fillable forms; no paid service.
- **PLT-37** Simulation annex on every product: scorecards, assumptions, seed, tape hash, engine version, fallbacks.

**Resilience**
- **PLT-38** Offline-first PWA, persisted storage, offline-pack check in the pre-event checklist.
- **PLT-39** Crash recovery: local autosave, persisted engine snapshots, deterministic resume, resync by `seq`.
- **PLT-40** Server-authoritative time, visible skew, UTC + America/New_York, RFC 3339 exports, game clock distinct from wall clock.
- **PLT-41** Compute Pressure throttling where available, manual battery saver, wake lock on wallboards.
- **PLT-42** CI budgets: INP ≤200 ms p75; 60 fps target, 30 fps floor; ≥10× real time per plan with three plans; LAN fan-out ≤1 s.

**Quality**
- **PLT-43** CI pyramid: engine verification, determinism, published validation suite, contract, fault-injected integration, multi-context e2e, visual regression.
- **PLT-44** WCAG 2.1 AA minimum (2.2 AA target): axe-core in CI plus manual passes.
- **PLT-45** SemVer for contract and file schemas; files embed schema, engine version, seed, tape hash; migrations tested.
- **PLT-46** SBOM, licence allowlist flagging GPL/AGPL/non-commercial, signed releases.
- **PLT-47** Telemetry off by default, agency-local, no personal data, free text or unit positions.

**Scope and labelling**
- **PLT-48** Exercise mode: EXERCISE banners, CAP `Exercise`, separate stream, MSEL visible only to controllers and trusted agents.
- **PLT-49** Provenance on every number (simulated/observed/estimated/assumed/default, source, as-of, uncertainty); ICS plain language, 24-hour times, no jargon in products.
- **PLT-50** Scope statement on start screen, About and footers: not CAD, dispatch, radio, alerting, RMS or surveillance; not a forecast unless calibrated; not evidence.

## Sources

All accessed 26 Oct 2026. Repo files are cited by path (`server/src/*.ts`, `app/src/*.ts`, `vercel.json`, `.env.example`, `CHECK THIS.MD`, `GOAL.md`, `README.md`, `docs/forecast.md`).

*Deployment, cloud, networks*
- [LEADS Manual ch. 13 Security Policy (2026)](https://leads.ohio.gov/Documents/Manuals/LEADSManual/13%20Security%20Policy%20-%202026.pdf) · [Microsoft — CJIS offering](https://learn.microsoft.com/en-us/azure/compliance/offerings/offering-cjis) · [FedRAMP Marketplace guide](https://www.fedramp.gov/marketplace/guide/) · [GovRAMP FAQ](https://govramp.org/faqs)
- [PERF — FirstNet deployables](https://www.policeforum.org/assets/FirstNetDeployables.pdf) · [FirstNet Authority — Green Bay police](https://firstnet.gov/newsroom/blog/connecting-green-bay-law-enforcement-and-field)
- [Node.js 25.5.0 release](https://nodejs.org/en/blog/release/v25.5.0) · [Hono WebSocket helper](https://hono.dev/docs/helpers/websocket)

*Security and identity*
- [FBI CJIS Security Policy v6.1](https://le.fbi.gov/file-repository/cjis_security_policy_v6-1_20260625.pdf/view) · [CJIS Appendix A](https://le.fbi.gov/cjis-division/cjis-security-policy-resource-center/appendicies)
- [NIST SP 800-63B-4 AALs](https://pages.nist.gov/800-63-4/sp800-63b/aal/) · [NIST SP 800-53 Rev. 5](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final) · [NIST SP 800-52 Rev. 2 (TLS)](https://csrc.nist.gov/pubs/sp/800/52/r2/final)
- [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) · [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) · [SAML 2.0 Core](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf) · [W3C WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/) · [MDN — service workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)
- [Juvare — WebEOC Nexus key concepts](https://docs.juvare.com/webeoc-onnexa/webeoc-nexus-key-concepts.htm)

*Ohio records*
- [ORC 149.011](https://codes.ohio.gov/ohio-revised-code/section-149.011) · [ORC 149.43](https://codes.ohio.gov/ohio-revised-code/section-149.43) · [ORC 149.433](https://codes.ohio.gov/orc/149.433)
- [Columbus Division of Police retention schedule (2023 update)](https://www.columbus.gov/files/sharedassets/city/v/1/public-safety/police/divisionofpoliceretentionschedule2023update.pdf) · [Ohio History Connection — suggested general schedule (2022 draft)](https://www.ohiohistory.org/research/local-government-records-program/local-retention-schedules-forms/general-schedule-draft-2022/)
- [OSU Records Management](http://go.osu.edu/records) · [Ohio AG — 2026 Sunshine Laws manual release](https://www.ohioattorneygeneral.gov/Media/News-Releases/March-2026/AG-Yost-Releases-2026-Yellow-Book-Provides-Guidanc)

*Collaboration, offline, time, performance*
- [Fowler — Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) · [RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455) · [Ink & Switch — Local-first](https://www.inkandswitch.com/essay/local-first/) · [caniuse — Background Sync](https://caniuse.com/background-sync)
- [MDN — Storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) · [MDN — Compute Pressure API](https://developer.mozilla.org/en-US/docs/Web/API/Compute_Pressure_API)
- [RFC 5905](https://datatracker.ietf.org/doc/html/rfc5905) · [Kleppmann — Distributed Systems notes](https://www.cl.cam.ac.uk/teaching/2223/ConcDisSys/dist-sys-notes.pdf) · [web.dev — INP](https://web.dev/articles/inp) · [RAIL](https://developers.google.com/web/fundamentals/performance/rail)

*Feeds and standards*
- [NWS API](https://www.weather.gov/documentation/services-web-api) (plus live `api.weather.gov/points/40.0016,-83.0197`)
- [NCEI lightning products](https://www.ncei.noaa.gov/products/lightning-products) · [NCEI GOES ABI/GLM](https://www.ncei.noaa.gov/products/goes-terrestrial-weather-abi-glm) · [NOAA GLM L2](https://repository.library.noaa.gov/view/noaa/49140/noaa_49140_DS1.html) · [GLM performance guide](https://origin-east-01-www-ospo.woc.noaa.gov/operations/goes/product-quality-overview/ps-pvr/goes-16/GLM/Full/GOES16_GLM_FullValidation_ProductPerformanceGuide.pdf) · [AWS — NOAA GOES](https://registry.opendata.aws/noaa-goes/)
- [Blitzortung terms](https://www.blitzortung.org/en/contact.php?lang=en) · [NATA lightning guidelines](https://www.nata.org/press-release/nata-provides-guidelines-lightning-safety) · [NCAA 2024-25 venue safety best practices](https://ncaaorg.s3.amazonaws.com/championships/resources/common/2024-25NCAAChamp_BestPracticesVenueSafetySecurity.pdf)
- [OHGO API](https://publicapi.ohgo.com/) · [OHGO terms](https://publicapi.ohgo.com/docs/terms-of-use) · [FHWA signal performance measures](https://ops.fhwa.dot.gov/arterial_mgmt/performance_measures.htm) · [FHWA V2X Hub](https://highways.dot.gov/sites/fhwa.dot.gov/files/FHWA-HRT-22-047.pdf)
- [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/) · [Tile policy](https://operations.osmfoundation.org/policies/tiles/) · [Overpass commons](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html) · [OSMF attribution](https://wiki.osmfoundation.org/wiki/Attribution_Guidelines) · [OSMF horizontal layers](https://osmfoundation.org/wiki/Community_Guidelines/Horizontal_Map_Layers_-_Guideline)
- [Ticketmaster Presence API](https://developer.ticketmaster.com/products-and-docs/apis/presence/) · [ISO/TS 5206-1](https://www.iso.org/standard/80997.html) · [IPMI — ISO adopts APDS](https://www.parking-mobility.org/news/iso-formally-adopts-global-parking-data-specification-based-on-alliance-for-parking-data-standards-data-specification/)
- [NIEM Model 6.0](https://docs.oasis-open.org/niemopen/niem-model/v6.0/niem-model-v6.0.pdf) · [NENA/APCO EIDD](https://www.nena.org/?page=EIDD_INF) · [NENA EIDO](https://www.nena.org/news/584569/NENA-Releases-ANSI-Approved-Emergency-Incident-Data-Object-EIDO-Standard.htm) · [OASIS CAP 1.2](https://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html)
- [FEMA IPAWS sign-up](https://www.fema.gov/emergency-managers/practitioners/integrated-public-alert-warning-system/public-safety-officials/sign-up) · [IPAWS 101](https://www.fema.gov/sites/default/files/documents/fema_ipaws_101-slicksheet_042024.pdf)
- [Ohio DAS — MARCS](https://das.ohio.gov/technology-and-strategy/marcs/07-MARCS) · [MARCS programming keys](https://dam.assets.ohio.gov/image/upload/das.ohio.gov/technology-strategy/marcs/MPP%2014%20System%20Programming%20Keys%20-%201_11_2021.pdf) · [CISA ISSI/CSSI primer](https://www.cisa.gov/sites/default/files/publications/20190130%20ISSI-CSSI%20Primer%20FINAL%20508C.pdf)
- [RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946) · [OGC KML](https://ogc.org/standards/kml/) · [OGC GeoPackage](https://www.geopackage.org/spec/) · [Esri applyEdits](https://developers.arcgis.com/rest/services-reference/enterprise/apply-edits-feature-service-layer/) · [TAK.gov](https://tak.gov/products) · [DHS TAK fact sheet](https://www.dhs.gov/sites/default/files/publications/5298_tak_factsheet_2020_v2.pdf) · [ATAK-CIV](https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV)

*Products, practice, quality*
- [FEMA ICS forms descriptions](https://training.fema.gov/emiweb/is/icsresource/assets/ics%20forms%20descriptions.pdf) · [FEMA ICS Resource Center](https://training.fema.gov/emiweb/is/icsresource/) · [FEMA Planning P](https://training.fema.gov/emiweb/is/icsresource/assets/incident%20action%20planning%20process.pdf) · [FEMA IS-15.b](https://training.fema.gov/is/courseoverview.aspx?code=is-15.b&lang=en)
- [HSEEP 2020](https://www.fema.gov/sites/default/files/2020-04/Homeland-Security-Exercise-and-Evaluation-Program-Doctrine-2020-Revision-2-2-25.pdf) · [NIMS 2017](https://www.fema.gov/sites/default/files/2020-07/fema_nims_doctrine-2017.pdf) · [CISA plain-language guide](https://www.cisa.gov/sites/default/files/publications/Making%20the%20transition%20form%2010codes%20to%20plain%20language.pdf)
- [Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) · [ISO 20414](https://www.iso.org/standard/78348.html) · [NIST TN 1822](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.1822.pdf) · [RiMEA](https://rimea.de/) · [Pathfinder V&V](https://www.thunderheadeng.com/docs/2024-1/pathfinder/verification-validation/) · [Pathfinder V&V 2019.2](https://files.thunderheadeng.com/support/files/verification_validation_2019_2.pdf)
- [ADA.gov — Title II web rule](https://www.ada.gov/resources/2024-03-08-web-rule/) · [Federal Register 2026-07663](https://public-inspection.federalregister.gov/2026-07663.pdf) · [SemVer 2.0.0](https://semver.org/) · [W3C PROV-O](https://www.w3.org/TR/prov-o/)
- Licences via GitHub: MIT — [pdf-lib](https://github.com/Hopding/pdf-lib), [Paged.js](https://github.com/pagedjs/pagedjs), [PptxGenJS](https://github.com/gitbrent/PptxGenJS), [ws](https://github.com/websockets/ws), [openid-client](https://github.com/panva/openid-client), [node-saml](https://github.com/node-saml/node-saml), [SimpleWebAuthn](https://github.com/MasterKale/SimpleWebAuthn), [Yjs](https://github.com/yjs/yjs), [Automerge](https://github.com/automerge/automerge); BSD-3-Clause — [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js), [PMTiles](https://github.com/protomaps/PMTiles), [SQLCipher](https://github.com/sqlcipher/sqlcipher), [mkcert](https://github.com/FiloSottile/mkcert); Apache-2.0 — [Planetiler](https://github.com/onthegomap/planetiler), [Playwright](https://github.com/microsoft/playwright), [OpenTelemetry JS](https://github.com/open-telemetry/opentelemetry-js), [Typst](https://github.com/typst/typst); MPL-2.0 — [axe-core](https://github.com/dequelabs/axe-core), [axe-core-npm](https://github.com/dequelabs/axe-core-npm)

Content was rephrased for compliance with licensing restrictions.
