# WS3 Platform: handoff

Branch `feat/v3-server`, worktree `/projects/sandbox/wt/server`. Pushed to `origin/feat/v3-server`. Updated 27 Oct 2026, when the owner asked the first agent to stop and hand over. **A continuation agent picks up at "Plan for the continuation" below.**

## State in one paragraph

The server is a platform now: accounts, sessions, MFA, position-based access on every route, a hash-chained audit log with signed checkpoints, an append-only event log with a WebSocket hub, versioned scenarios and plans, package files, comparisons with seed and tape hash, an allowlisted outbound fetch that replaces the open `/api/conditions/fetch`, an NWS weather adapter, and the ICS/EAP/sitrep/AAR/GIS/CAP products. `node server/src/index.ts` still starts with zero configuration and every v2 `/api/*` route still works. `npm run typecheck` is clean; `npx vitest run` gives **538 passed, 3 skipped** (66 files; baseline was 358). Not started: the browser client in `app/src/platform/`, the Vercel demo additions, and unit tests for the products.

## Commits

| Commit | What |
| --- | --- |
| `6d4c158` | `ws` dependency; recorded NWS fixtures |
| `acc5b3b` | Identity, sessions, CSRF, rate limits, TOTP, RBAC on every route, audit chain, event log, WebSocket hub |
| `502f55e` | Versioned documents, packages, comparisons, v2 plan persistence (D-14), SSRF guard, NWS adapter |
| `549a463` | Products: ICS 201–208, 214, EAP bundle, simulation annex, sitrep, AAR/IP, GeoJSON, KML, CAP drafts; print check script |
| (this commit) | Handoff, `docs/v3/api.md`, `docs/v3/deploy.md`, `docs/licences/WS3.md`, `.env.example` |

## How to run

```sh
npm install
node server/src/index.ts                  # zero config: loopback, no accounts, v2 routes for loopback callers
npm run admin:create -- --username chief.admin [--grant incident_commander@osu-2026]
GAMEDAY_DEMO=1 node server/src/index.ts    # no sign-in, labelled demo
GAMEDAY_FEED_CONTACT=ops@agency.example.gov npm run weather:check   # live NWS check
npm run backup                             # VACUUM INTO copy + audit key + manifest
npx vitest run server/                     # the server tests (about 10 s)
source /projects/sandbox/.kiro/env.sh && HOME=/projects/sandbox/.scratch/home node server/scripts/products-check.ts out-dir --shots shots-dir
```

Headless Chromium needs a writable `HOME` in this sandbox (crashpad fails on read-only `/root`).

## What is built, by deliverable

1. **Identity and access** (`server/src/auth/`). scrypt N=2^15, r=8, p=3 (OWASP tier), parameters in each PHC hash, rehash on sign-in when policy rises; about 0.2 s per hash here. Cookie `gd_session` (HttpOnly, SameSite=Strict; `__Host-` and Secure over TLS); DB stores SHA-256 of the token; 12 h absolute and 30 min idle by default, clamped to 24 h and 60 min; revocation pushes to the hub, which closes sockets (4401). CSRF: `X-CSRF-Token` from `GET /api/v3/auth/session` on every cookie write, plus Origin and Sec-Fetch-Site checks and JSON-only bodies. Throttling: 5 failures per account and 20 per address in 15 min (memory only). TOTP per RFC 6238 with replay protection; MFA required by default (`GAMEDAY_MFA=optional` turns it off). `IdentityProvider` interface with local passwords and a documented OIDC stub (`identity.ts`). First run: `npm run admin:create` or `GAMEDAY_ADMIN_USER`/`GAMEDAY_ADMIN_PASSWORD`; no default password; the server refuses a non-loopback `HOST` while no account exists. 22 positions, 46 permissions, one table (`rbac.ts`) and one `can()`; admin has no operational content; unit-bound positions act only for their unit. Wallboard display grants with one-time pairing codes.
2. **Audit** (`server/src/audit/audit.ts`). Append-only (SQLite triggers), SHA-256 chain over the previous hash and canonical JSON (RFC 8785-compatible), Ed25519 checkpoints every 100 entries and on demand, key in its own file (`data/audit-ed25519.pem`, 0600). Verify detects edits, deletions, truncation, rewritten chains and forged checkpoints (tested). Video-view hook for WS5: `POST /api/v3/audit/video-views`. Secrets and long text never enter details.
3. **Event log and collaboration** (`server/src/events/`). PLAN §5.6 envelope, server `seq`, client UUID idempotency, per-stream mode lock (exercise apart from live), hash chain, compare-and-set assignments, idempotent acknowledgements, need-to-know (`visibleTo`: field units see their own assignments; evaluator notes only for control). Hub at `/api/v3/events` (`ws`): auth at handshake, Origin check, replay since `seq`, presence per position, 15 s heartbeat, log-backed backpressure, clock ping.
4. **Scenarios and plans** (`server/src/library/`). Draft → reviewed → approved, CAS on revision, approved immutable (triggers), edit makes n+1, optional two-person rule; package files with schema/engine/contract versions, seed, integrity hash, import as drafts; comparisons with seed(s), tape hash, versions. `POST /api/plans` (v2) now saves through the document store, so plans survive a reload (D-14, tested across two app instances).
5. **Security hygiene**. `server/src/net/`: admin allowlist (seeded with api.weather.gov), private/loopback/link-local/CGNAT/ULA/mapped/NAT64/6to4 refused after DNS and on every redirect, connection pinned to the vetted address (rebinding), size and time limits. CSP and headers in `platform/headers.ts`; optional TLS (`TLS_CERT_FILE`, `TLS_KEY_FILE`, TLS 1.2+); body limits per route.
6. **Feeds** (`server/src/feeds/`). NWS `/points` → stations → latest observation, hourly forecast, active alerts; ETag/Last-Modified/Expires cache in SQLite, backoff (5 s doubling to 15 min, Retry-After honoured); US units; provenance and staleness on every value; unknown is null with a reason. Off until `GAMEDAY_FEED_CONTACT` is set. **Live smoke test, 27 Oct 2026 02:05 UTC: status ok in 933 ms; KOSU 53.6 °F, wind WNW 3.4 mph, gust unknown, visibility 10 mi, 30.29 inHg; 48 hourly periods; no active alerts.**
7. **Products** (`server/src/products/`). See the commit above. Screenshots: `/projects/sandbox/.kiro/artifacts/screenshots/ws3-eap-cover.jpg`, `ws3-ics202.jpg`, `ws3-ics204.jpg`, `ws3-ics205-radio.jpg`, `ws3-map.jpg`, `ws3-simulation-annex.jpg`, `ws3-sitrep.jpg`, `ws3-aar-ip.jpg`. The print check passes for all 14 HTML products (no overflow; PDF page count equals the printed "page X of Y").
8. **Docs**. `docs/v3/api.md`, `docs/v3/deploy.md`, `docs/licences/WS3.md`, `.env.example`.

## Plan for the continuation (in this order)

1. **Product fixes seen in the screenshots** (small):
   - Footer: the scope line overlaps the bottom marking. In `products/layout.ts` raise the footer row from 66 px to about 86 px in both `CHROME` and `grid-template-rows`, then re-run the print check.
   - EAP marking: every page prints RESTRICTED because the bundle holds the 205. In `renderProduct` pass the plan's own classification in `meta` to `eapDocument` (the 205 sheet already raises its own page) while keeping the overall classification restricted for permission and audit.
   - AAR labels: "first report.. Strengths" (strip the objective's final period in `aar.ts`).
   - Map sketch: labels collide at the stadium. Add greedy label placement in `geo.ts sketchSvg`, add a features table after the sketch on the EAP map page, and in `products-check.ts` choose small lots (not "All lots", 41,030 cells) as sample zones.
   - Sitrep sample: build its weather from the NWS fixtures so the print shows observed/forecast labels and staleness.
2. **Product tests** (`server/src/products/products.test.ts`): CAP structure parsed with `@xmldom/xmldom` (already a dev dependency; strict error handler; namespace, element order, status only Exercise/Draft, `sent` with offset and never `Z`, polygon/circle formats, CMAMtext ≤ 90 and CMAMlongtext ≤ 360, refusal of an over-long WEA text); KML parsed and every coordinate tuple inside Columbus (lat 39.99–40.01, lon −83.03 to −83.01); GeoJSON rings closed and counter-clockwise, `worldToLngLat` corners against `MapBundle.geo`; each ICS form's box labels present; page numbering consistent; route permissions (PIO cannot export the 205; restricted needs `product.export.restricted`; CAP needs `cap.draft`; audit entry with sha256); ICS 214 from the event log leaves free text out unless `includeFreeText`.
3. **Client library** `app/src/platform/` (not started): `types.ts` (re-export `server/src/types.ts`), `client.ts` (REST with `credentials: 'same-origin'`, CSRF header, typed errors), `events.ts` (WebSocket with reconnect and jittered backoff, resubscribe from last `seq` per stream, dedupe by `seq`, presence, NTP-style offset from `ping`/`pong`), outbox (IndexedDB, memory fallback; queued → delivered(seq) → acknowledged; kept across 4401 until sign-in), `BroadcastChannel` transport for solo mode with a leader assigning local seqs and the same frames, and a small `useEventStream` hook on `useSyncExternalStore`. Test against `startServer({ port: 0 })` with the `ws` client (cookie header) and Node's global `BroadcastChannel`. Add `app/src/platform` to nothing else; the strip check in `server/src/boot.test.ts` already covers it.
4. **Vercel demo**: `scripts/static-api.ts` should call `createApp(db, { config: { ...loadConfig(), demo: true } })` and also freeze `/api/v3/health`, `/api/v3/meta`, `/api/v3/auth/session` and `/api/v3/feeds/weather` (demo report, status `not_configured`); add the rewrites to `vercel.json`; optionally `api/products.js` rendering products with `demo: true`. Then `npm run build && node scripts/static-api.ts` to prove it still builds. (Today the static build is unchanged in output: on Vercel `VERCEL=1` already turns demo mode on.)
5. **Hallmark sweep** on one product HTML: `node /projects/sandbox/.kiro/skills/hallmark/scripts/sloplint.mjs <file> --scope app --render`; fix FAILs (the stamp is in `layout.ts STYLE`).
6. Later: OIDC with `openid-client` (record its licence), SAML, passkeys, retention classes and legal holds (PLT-16), OHGO and GLM adapters, 209 snapshots.

## Known issues

- The five product layout items in step 1.
- `@xmldom/xmldom` is declared but not used yet (step 2 uses it).
- Hub presence is per process; one server per deployment is assumed.
- NWS: lightning is always unknown (not in the feed); alerts are filtered by the venue point only.
- Display sessions stay alive while their WebSocket answers the heartbeat (by design, PLT-09); the 24 h ceiling still applies.

## Requests for the integration lead and the UI team

- **Vite proxy**: `app/vite.config.ts` needs `proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } }` for the hub in dev (WS3 does not own that file).
- **Shell (WS6)**: a sign-in screen (`POST /api/v3/auth/login`, then `mfa_required` → code field; `stage: 'mfa_enrolment'` → show `otpauthUri` as a QR or text and confirm), a session timer from `idleExpiresAt`, a position switcher from `grants`, and hiding controls with `permissions[scope]` (the server still checks).
- **Which screens use what**:

  | Screen | Endpoints | Events |
  | --- | --- | --- |
  | Sign-in, account | `auth/login`, `auth/session`, `auth/mfa/totp/*`, `auth/password`, `auth/logout` | — |
  | Plan editor (fixes D-14) | `GET/POST/PUT /documents`, `.../review`, `.../approve`, `GET /documents/:id/versions` | `document.reviewed`, `document.approved` |
  | Rehearse, comparison cards | `POST /comparisons` (seed, tape, versions) | `decision.recorded` |
  | Officer console, Field route (replaces the same-tab radio sync) | WS `/events`, `GET /assignments` | `assignment.*`, `unit.status`, `report.created` |
  | Ops status board, request queue | WS `/events`, `GET /presence` | `assignment.*`, `report.*`, `incident.*`, `order.simulated` |
  | Exercise controller, evaluator | WS `/events` (exercise stream), `/documents?kind=exercise` | `inject.released`, `observation.recorded`, `exercise.*` |
  | Top bar weather | `GET /feeds/weather` | — |
  | Exports menu | `POST /products/:kind`, `GET /documents/:id/versions/:v/eap`, `/packages/export`, `/packages/import` | — |
  | Admin | `/users`, `/grants`, `/sessions`, `/display-grants`, `/feeds/allowlist`, `/audit`, `/audit/verify` | — |
  | Wallboard | `auth/display` (pairing code), WS `/events` | read-only |
  | Video (WS5) | `POST /audit/video-views` on start and stop | `feed.viewed` (optional) |

- **WS4**: `server/src/types.ts` `Provenance` matches PLAN §5.7 with optional `fetchedAt`, `staleAfterS`, `stale`, `licence`, `url`, and `range: { low, high }`; please keep `app/src/analysis/provenance.ts` compatible.
- **WS8**: merge note: root `package.json` gains `admin:create`, `backup`, `weather:check`; the default bind is now `127.0.0.1` (set `HOST` for a LAN).
