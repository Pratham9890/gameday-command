# Gameday Command platform API (v3)

REST under `/api/v3`, a WebSocket at `/api/v3/events`, JSON in and out. Types are in [`server/src/types.ts`](../../server/src/types.ts) (the browser client re-exports them). The v2 routes under `/api` keep working; each now needs a permission too (table at the end).

## Conventions

- **Authentication.** A session cookie (`gd_session`, or `__Host-gd_session` over TLS; HttpOnly, SameSite=Strict) set by `POST /api/v3/auth/login`. Sessions end 12 h after sign-in or 30 min after the last request by default (at most 24 h and 60 min). In demo mode (`GAMEDAY_DEMO=1`) every caller is the labelled demo user. Before the first account exists, `/api/v3` answers `503 setup_required` and the v2 routes answer loopback callers only.
- **CSRF.** Every cookie-authenticated `POST`, `PUT`, `PATCH` and `DELETE` sends `X-CSRF-Token` (the `csrfToken` from `GET /api/v3/auth/session`), except `auth/login`, `auth/display`, `/api/decide` and `/api/briefing`. Any write with a foreign `Origin` or `Sec-Fetch-Site: cross-site` is refused. JSON bodies need `content-type: application/json`.
- **Permissions.** Every route names one; `can(actor, permission, { scope, unit, classification })` decides (`server/src/auth/rbac.ts`). `GET /api/v3/meta` lists positions and their permissions. "In scope" means the actor holds a position in that event or exercise (or in `*`).
- **Errors.** `{ "error": "code", "message": "plain words", ...details }` with 400 invalid, 401 not signed in, 403 forbidden (or `csrf`, `bad_origin`, `mfa_enrolment_required`), 404, 409 conflict (`version_conflict` carries `current`), 413 too large, 415 not JSON, 422 unprocessable, 429 rate limited (`Retry-After`), 503 setup required.
- **Times** are RFC 3339 UTC in JSON; products print 24-hour America/New_York.
- **Free text** (notes, rationales, document notes, CAP texts) is checked for personal-data shapes; responses carry `warnings`, and products leave free text out unless asked.

## Public and session

| Method and path | Auth | Body → response |
| --- | --- | --- |
| `GET /api/v3/health` | none | `{ ok, apiVersion, mode, demo, setupRequired, tls, feeds, serverTime }` |
| `GET /api/v3/meta` | none | positions with permissions, event types (permission, modes, free-text fields), product kinds, schema versions, identity providers |
| `GET /api/v3/auth/session` | any | `SessionInfo`: `mode`, `user`, `grants`, `permissions` per scope, `stage`, `csrfToken`, `absoluteExpiresAt`, `idleExpiresAt`, `policy` |
| `GET /api/v3/auth/providers` | none | identity providers (`local`; `oidc` stub, disabled) |
| `GET /api/v3/auth/oidc/:provider/start` | none | `501 not_configured` until OIDC is built |
| `POST /api/v3/auth/login` | none | `{ username, password, totp? }` → `SessionInfo` and cookie; `401 invalid_credentials` (same for unknown accounts), `401 mfa_required`, `401 invalid_mfa`, `429` after 5 failures per account or 20 per address in 15 min |
| `POST /api/v3/auth/logout` | session | ends this session |
| `POST /api/v3/auth/logout-all` | session | ends every session of this account |
| `POST /api/v3/auth/mfa/totp/setup` | session (any stage) | → `{ secret, otpauthUri, algorithm: 'SHA1', digits: 6, periodS: 30 }` |
| `POST /api/v3/auth/mfa/totp/confirm` | session | `{ code }` → new full session (`SessionInfo`) |
| `POST /api/v3/auth/password` | full session | `{ current, next }`; ends the other sessions |
| `POST /api/v3/auth/display` | none | `{ code }` (pairing code) → read-only display session |

With `GAMEDAY_MFA=required` (default) a first sign-in without TOTP returns `stage: 'mfa_enrolment'`; that session can only enrol.

## Administration

| Method and path | Permission | Body → response |
| --- | --- | --- |
| `GET /api/v3/users` | `user.manage` (scope `*`) | accounts with grants |
| `POST /api/v3/users` | `user.manage` | `{ username, displayName, password }` (12+ characters, not common) → account |
| `PATCH /api/v3/users/:id` | `user.manage` | `{ displayName?, disabled? }`; disabling ends sessions |
| `POST /api/v3/users/:id/password` | `user.manage` | `{ password }`; ends sessions |
| `DELETE /api/v3/users/:id/mfa` | `user.manage` | resets TOTP; ends sessions |
| `GET /api/v3/grants?userId=&scope=` | `grant.manage` | grants |
| `POST /api/v3/grants` | `grant.manage` | `{ userId, position, scope, unit? }` (`admin` and `records` only in `*`) |
| `DELETE /api/v3/grants/:id` | `grant.manage` | open sockets re-check their streams |
| `GET /api/v3/sessions?userId=&all=1` | `session.revoke` | sessions (no addresses are stored) |
| `DELETE /api/v3/sessions/:id` | `session.revoke` | ends it and closes its sockets |
| `GET /api/v3/display-grants?scope=` | `display.manage` in scope | wallboard grants |
| `POST /api/v3/display-grants` | `display.manage` in scope | `{ scope, label }` → `{ grant, code }` (code valid 10 min, once) |
| `DELETE /api/v3/display-grants/:id` | `display.manage` in scope | revokes; the wallboard's session ends |
| `GET /api/v3/feeds/allowlist` | `allowlist.manage` | outbound allowlist |
| `POST /api/v3/feeds/allowlist` | `allowlist.manage` | `{ host, ports?, httpsOnly?, note? }`; `*.domain` for subdomains |
| `DELETE /api/v3/feeds/allowlist/:host` | `allowlist.manage` | — |

## Audit

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /api/v3/audit?since=&limit=&action=` | `audit.read` | `AuditEntry[]`: seq, at, actor (account, position), action, target, outcome, detail, prevHash, hash |
| `GET /api/v3/audit/verify` | `audit.verify` | recomputes the chain and checkpoints: `{ ok, entries, problems[], checkpoints, eventLog, publicKey }` |
| `GET /api/v3/audit/checkpoints` | `audit.read` | signed checkpoints and the Ed25519 public key (SPKI, base64) |
| `POST /api/v3/audit/checkpoints` | `audit.checkpoint` | sign the head now |
| `POST /api/v3/audit/video-views` | `video.view` in scope | `{ scope, feedId, action: 'start'|'stop', zones? }`; call on every feed open and close |

Audited actions: sign-ins and failures, sign-outs, MFA enrolment and resets, password changes, session expiry and revocation, account and grant changes, display grants, document create/update/review/return/approve, restricted document views, package import/export, comparisons, product exports and CAP drafts (with the output's SHA-256), video views, feed refreshes, allowlist changes, blocked outbound requests, access denials, checkpoints and verifications.

## Event log

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /api/v3/streams?scope=` | `event.read` | streams with their mode |
| `GET /api/v3/events?stream=&since=&limit=` | `event.read` in the stream's scope | `{ events, lastSeq, more }`; continue from `lastSeq` |
| `POST /api/v3/events` | per event type (below) | `AppendRequest` → `201 { event, duplicate: false, warnings? }`, or `200` for a repeated id |
| `GET /api/v3/assignments?stream=` | `event.read` | current assignment states (field units: their own) |
| `GET /api/v3/presence?stream=` | `event.read` | who holds which position, last heard |

`AppendRequest`: `{ id (client UUID, the idempotency key), stream ("event-id" or "event-id/period"), type, mode: plan|rehearse|exercise|live, payload, clientTime?, simTime?, causedBy?, asPosition? }`. The stored envelope (PLAN §5.6): `{ seq, id, stream, type, actor: { userId, position }, serverTime, clientTime, simTime?, mode, causedBy?, payload, hash }`. A stream keeps the mode of its first event; exercise events need their own stream.

| Type | Permission | Payload | Notes |
| --- | --- | --- | --- |
| `assignment.created` | `assignment.write` | `assignmentId, unit, division?, task, place?, priority?` | version 1 |
| `assignment.updated` | `assignment.write` | `assignmentId, expectedVersion, task?, place?, priority?, division?` | compare-and-set; 409 with `current` |
| `assignment.reassigned` | `assignment.write` | `assignmentId, expectedVersion, unit, division?` | both units see it |
| `assignment.acknowledged` | `assignment.respond` (own unit) | `assignmentId, version` | idempotent per version and account |
| `assignment.completed` | `assignment.respond` | `assignmentId, version` | |
| `assignment.cancelled` | `assignment.write` | `assignmentId, expectedVersion, reason?` | |
| `unit.status` | `assignment.respond` (own unit) | `unit, status, place?` | available, assigned, en_route, on_scene, returning, out_of_service |
| `report.created` | `report.create` | `reportId, kind, unit?, place?, priority?` | |
| `report.decided` | `report.decide` | `reportId, decision, assignmentId?` | |
| `order.simulated` | `order.simulate` | `runId?, planLabel?, order` | today's `PoliceOrder`; plan, rehearse, exercise only |
| `decision.recorded` | `decision.record` | `title, choice, rationale?, comparisonId?` | free text |
| `note.logged` | `note.log` | `text, unit?` | free text |
| `incident.declared` / `incident.updated` | `incident.declare` | `incidentId, kind, place?, severity?` / `incidentId, status` | |
| `inject.released` | `exercise.control` | `injectId, mselNumber?, title, to?` | exercise only |
| `observation.recorded` | `exercise.evaluate` | `observationId, objectiveId?, capability?, text, rating?` | exercise only; hidden from players, observers, displays |
| `exercise.started` / `paused` / `ended` | `exercise.control` | `exerciseId` | exercise only |
| `feed.viewed` | `video.view` | `feedId, action` | |
| `document.reviewed` / `document.approved` | server only | `documentId, kind, version, name` | on `<scope>/library` |

Field units see only assignment events for their unit, incidents, exercise control and injects addressed to them.

### WebSocket `/api/v3/events`

Authenticated at the handshake (cookie, or demo mode); a foreign `Origin` gets 403, no session 401. Frames are JSON.

- Client: `{ t: 'subscribe', stream, since? }`, `{ t: 'unsubscribe', stream }`, `{ t: 'append', event: AppendRequest }`, `{ t: 'presence', stream, position, status? }`, `{ t: 'ping', id, clientTime }`.
- Server: `hello` (protocol `gameday.events.1`, demo flag, heartbeat), `subscribed`, `event` (envelope), `replayed` (`lastSeq` once caught up), `ack` (`id, seq, duplicate`), `nack` (`status, error, message, current?`), `presence` (entries), `pong` (`serverReceived`, `serverSent` for clock offset), `error`, `revoked`.
- Close codes: 4401 session revoked or expired, 4403 no positions left, 1013 too far behind (reconnect and replay), 1008 rate limit, 1001 server stopping.
- Heartbeat every 15 s; a socket that misses a pong is dropped. A slow socket is not buffered: sending pauses above 1 MB and resumes from its last seq; above 8 MB it is closed.

## Scenarios, plans, exercise packages

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /api/v3/documents?kind=&scope=` | `<kind>.read` | latest version of each (no bodies) |
| `POST /api/v3/documents` | `<kind>.write` in scope | `{ id?, kind: scenario|plan|exercise, scope, name, classification?, body }` → `201 { document, warnings }` (version 1, draft) |
| `GET /api/v3/documents/:id` | `<kind>.read` | latest with `versions` and `latestApproved`; restricted views audited |
| `GET /api/v3/documents/:id/versions` and `/versions/:version` | `<kind>.read` | |
| `PUT /api/v3/documents/:id` | `<kind>.write` | `{ expectedVersion, expectedRevision?, name?, classification?, body? }`; a draft is edited in place (`revision` + 1); an approved version makes version n + 1 (`201`, `newVersion: true`); stale tokens get 409 |
| `POST /api/v3/documents/:id/versions/:v/review` | `<kind>.review` | draft → reviewed; `{ expectedRevision? }` |
| `POST /api/v3/documents/:id/versions/:v/return` | `<kind>.review` | reviewed → draft |
| `POST /api/v3/documents/:id/versions/:v/approve` | `<kind>.approve` | reviewed → approved (immutable); `GAMEDAY_TWO_PERSON=1` bars the author |
| `GET /api/v3/documents/:id/export?version=&engineVersion=` | `<kind>.read` and `product.export` | package file download |
| `POST /api/v3/packages/export` | as above, per document | `{ documents: [{ id, version? }], comparisonIds?, engineVersion? }` |
| `POST /api/v3/packages/import` | `<kind>.write` in the target scope | `{ package, scope? }` → `{ imported, skipped, comparisons, warnings, packageHash }`; imports are drafts |

Bodies: plan `{ responsePlan?: ResponsePlan, ics?: IcsPlanSections, notes? }`; scenario `{ mapId, seed, incident?, startAt?, endAt?, weatherId?, traffic?, notes? }`; exercise `{ title, objectives, msel: MselEntry[], scenarioRef?, planRefs?, notes? }`. Unknown fields are kept.

Package file (`gameday.package`, schema 1.0.0): `{ format, schemaVersion, contractVersion, engineVersion, exportedAt, exportedBy, seed, classification, documents[], comparisons[], integrity: { algorithm: 'sha256', hash } }`; the hash is over the canonical JSON of the rest. A different major schema is refused (422); an altered file is refused.

## Comparisons

| Method and path | Permission | Notes |
| --- | --- | --- |
| `POST /api/v3/comparisons` | `comparison.write` in scope | `{ scope, incident, scorecards (1–3), seed, seeds?, tape? or tapeHash?, engineVersion, mapId, planRefs?, scenarioRef? }`; the tape hash is SHA-256 of the tape's canonical JSON, refused if it disagrees |
| `GET /api/v3/comparisons?scope=` / `GET /api/v3/comparisons/:id` | `comparison.read` | `ComparisonRecord` |

## Feeds

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /api/v3/feeds/weather` | `feed.read` | `WeatherReport`: status ok, stale, unavailable or not_configured; observation (US units, each value with provenance, unknown as null with a reason), hourly periods, active alerts, errors, attribution |
| `POST /api/v3/feeds/weather/refresh` | `feed.configure` | force a refresh |
| `POST /api/v3/feeds/fetch` | `feed.read` | `{ url }` → `{ text, fetchedAt, url, contentType, provenance }`; allowlisted public hosts only (`403 outbound_blocked` with `reason`), 512 KB, 8 s |

## Products

`POST /api/v3/products/:kind?format=html|json|xml|geojson|kml` with `{ scope, input, fromStream? }`. Permission `product.export` in scope (`product.export.restricted` for restricted output: the ICS 205 and any bundle that holds it), `cap.draft` for CAP. Responses carry `x-gameday-classification`, `x-gameday-sha256`, `x-gameday-pages`; HTML has a no-script CSP. Every export is audited.

| Kind | Input type | Output |
| --- | --- | --- |
| `ics201` | `Ics201Input` (+ optional `map: GeoExportInput` for the sketch) | ICS 201 Incident Briefing |
| `ics202` | `{ meta, sections: IcsPlanSections }` | ICS 202 Incident Objectives |
| `ics203` | `{ meta, organization }` | ICS 203 Organization Assignment List |
| `ics204` | `{ meta, assignments }` | one ICS 204 per division or group |
| `ics205` | `{ meta, radio: Ics205Plan | null }` | ICS 205, landscape, restricted; prints only agency entries |
| `ics206` / `ics208` | `{ meta, medical }` / `{ meta, safety }` | ICS 206 Medical Plan / ICS 208 Safety Message |
| `ics214` | `Ics214Input`, or `fromStream: { stream, position?, unit?, includeFreeText? }` to build entries from the event log | ICS 214 Activity Log |
| `eap` | `EapInput` | cover and contents, 202–208, map, simulation annex |
| `annex` | `{ meta, annex: SimulationAnnex }` | simulated outcomes, assumptions, seed, tape hash, versions, fallbacks |
| `sitrep` | `SitrepInput` | situation report |
| `aar` | `AarInput` | HSEEP AAR/IP skeleton |
| `geojson` / `kml` | `GeoExportInput` (map must have `geo`) | RFC 7946 FeatureCollection / KML 2.3, provenance on every feature |
| `cap` | `CapAlertInput` | CAP 1.2 XML (`format=xml`, default), review sheet (`html`) or `{ xml, check }` (`json`); Exercise or Draft only, never sent; WEA 90/360 checks |

`GET /api/v3/documents/:id/versions/:version/eap?format=&mode=exercise&comparisonId=` builds the Event Action Plan from a stored plan version (`body.ics`), with prepared and approved by from the workflow and the annex from the linked comparison. Needs `plan.read` and `product.export`.

Every page carries the classification marking, the EXERCISE or SIMULATION banner, prepared by, approved by (or "Not approved"), version and page X of Y.

## The v2 routes

| Route | Permission |
| --- | --- |
| `GET /api/health` | none |
| `GET /api/maps`, `GET /api/maps/:id`, `GET /api/decision-defaults`, `GET /api/history`, `GET /api/feedback` | `legacy.read` |
| `POST /api/decide`, `POST /api/briefing` | `legacy.compute` |
| `POST /api/history`, `POST /api/feedback` | `legacy.write` |
| `GET /api/plans` | `plan.read` |
| `POST /api/plans` | `plan.write` (now a versioned draft in scope `default`; returns `{ id, version, revision, status }`) |
| `POST /api/comparisons`, `GET /api/comparisons/:id` | `comparison.write`, `comparison.read` |
| `GET /api/stadiums/search`, `POST /api/stadiums/import` | `stadium.import` |
| `POST /api/conditions/fetch` | `feed.read`; allowlisted hosts only |

Any other path under `/api` is a 404.
