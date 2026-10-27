# Deploying Gameday Command

One Node process serves the API, the WebSocket hub, the SQLite database and (when `app/dist` is built) the app itself. Node 22.18 or later; no build step for the server. Research behind these choices: [06 platform integrations](../research/06-platform-integrations.md) §1, §2 and §6.

## Three ways to run it

| Mode | Where | How |
| --- | --- | --- |
| **A. Solo laptop** (tabletop, air-gapped) | One machine, nobody else connects | `node server/src/index.ts`. Listens on `127.0.0.1:8787`. Create an account with `npm run admin:create` before using `/api/v3`; until then the v2 routes answer this machine only. No outbound calls: feeds stay off. |
| **B. Command-post LAN** (game day, internet optional) | A laptop or small PC serving a closed Wi-Fi or Ethernet network | Accounts and TLS required in practice: `HOST=0.0.0.0`, `TLS_CERT_FILE`, `TLS_KEY_FILE`. The server refuses a non-loopback `HOST` while no account exists. Any uplink only feeds the adapters (`GAMEDAY_FEED_CONTACT` turns on the NWS feed; the allowlist holds anything else). |
| **C. Agency-hosted** | Behind the agency's reverse proxy and firewall | `HOST=0.0.0.0` on the internal interface, TLS at the proxy, `GAMEDAY_TRUST_PROXY=1`, `GAMEDAY_SECURE_COOKIES=1`, `GAMEDAY_ORIGINS=https://gameday.agency.example`. Back up `data/` (below). Single sign-on is an interface today (`server/src/auth/identity.ts`), not wired. |

The Vercel build is a public demo only: `VERCEL=1` turns demo mode on (no sign-in, labelled synthetic), writes are dropped, and no agency data belongs there.

## First run

```sh
npm install
npm run admin:create -- --username chief.admin            # asks for the password twice, never echoed
npm run admin:create -- --username ic.solo --grant incident_commander@osu-2026 --grant planning_chief@osu-2026
node server/src/index.ts
```

Scripted installs can pipe the password (`--password-stdin`) or set `GAMEDAY_ADMIN_USER` and `GAMEDAY_ADMIN_PASSWORD` (or `GAMEDAY_ADMIN_PASSWORD_FILE`) for the first start; the variables are ignored once any account exists, and should then be removed. There is no default password. Sign in, enrol an authenticator app when asked (TOTP), then create accounts and grant positions per event (`POST /api/v3/users`, `POST /api/v3/grants`, see [api.md](api.md)).

## Environment

Every variable is optional. `.env.example` has the full list with the v2 ones.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Bind address and port |
| `DB_PATH` | `./data/gameday.db` | SQLite file (WAL). The audit key goes beside it |
| `GAMEDAY_DEMO` | off | Public demo: no sign-in, demo user, everything labelled |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | none | PEM files; turns on HTTPS/WSS (TLS 1.2+), Secure cookies and HSTS |
| `GAMEDAY_SECURE_COOKIES` | off | Secure cookies when TLS ends at a proxy |
| `GAMEDAY_TRUST_PROXY` | off | Read the client address from `X-Forwarded-For` (rate limiting only) |
| `GAMEDAY_ORIGINS` | none | Extra origins allowed to call the API and open the WebSocket |
| `GAMEDAY_SESSION_HOURS`, `GAMEDAY_SESSION_IDLE_MINUTES` | 12, 30 | Clamped to 24 and 60 |
| `GAMEDAY_MFA` | `required` | `optional` lets accounts sign in without TOTP |
| `GAMEDAY_TWO_PERSON` | off | The author of a version may not review or approve it |
| `GAMEDAY_SCRYPT_LOG2N`, `_R`, `_P` | 15, 8, 3 | Password hashing cost; stored per hash, so raising it upgrades hashes at sign-in |
| `GAMEDAY_ADMIN_USER`, `GAMEDAY_ADMIN_PASSWORD(_FILE)`, `GAMEDAY_ADMIN_NAME` | none | First-run administrator |
| `GAMEDAY_AUDIT_KEY_FILE` | beside the database | Ed25519 key that signs audit checkpoints |
| `GAMEDAY_AUDIT_TRUSTED_KEYS` | none | Key ids of earlier keys whose checkpoints still verify after a rotation |
| `GAMEDAY_AUDIT_CHECKPOINT_EVERY` | 100 | Entries between signed checkpoints |
| `GAMEDAY_FEED_CONTACT` | none | Email or URL for the NWS User-Agent; setting it turns the weather feed on |
| `GAMEDAY_FEEDS` | on with a contact | `0` keeps feeds off even with a contact |
| `GAMEDAY_VENUE_NAME`, `_LAT`, `_LON` | Ohio Stadium, 40.0016478, −83.0197398 | The weather point |
| `GAMEDAY_CAP_SENDER` | `gameday-command.local` | CAP `<sender>` on drafts |
| `GAMEDAY_STATIC_DIR` | `app/dist` if built | Serve the built app from this server |
| `GAMEDAY_BODY_LIMIT_KB`, `GAMEDAY_LARGE_BODY_LIMIT_MB` | 1024, 16 | Request size limits (decisions and history get 8 MB, package import the large limit) |

Secrets (the admin password, the audit key, later the OIDC client secret) stay on the server: never in the app bundle or the repository.

## TLS on a LAN

Browsers need HTTPS for service workers and offline use off `localhost`. With the agency's CA, use its certificate. Otherwise [mkcert](https://github.com/FiloSottile/mkcert) (BSD-3-Clause) makes a local CA:

```sh
mkcert -install                                      # once per managed device, installs the local CA
mkcert gameday.local 192.168.50.10 localhost 127.0.0.1 ::1
TLS_CERT_FILE=./gameday.local+4.pem TLS_KEY_FILE=./gameday.local+4-key.pem HOST=0.0.0.0 node server/src/index.ts
```

Install the CA (`mkcert -CAROOT` shows where it is) on every device that connects; keep its private key off those devices.

## Outbound calls

The server calls only hosts on the administrator's allowlist (`/api/v3/feeds/allowlist`; `api.weather.gov` is listed on first run), never a private, loopback or link-local address, even after DNS or a redirect. Agency systems inside the network push data in through imports; the server does not pull from them. An air-gapped laptop needs no change: feeds stay off without `GAMEDAY_FEED_CONTACT`, and with one they report "unavailable" and keep the last good values, marked stale.

## Backup and restore

```sh
npm run backup                       # → backups/<timestamp>/gameday.db, audit-ed25519.pem, manifest.json
npm run backup -- /mnt/encrypted/gd  # or a directory of your choice
```

The copy uses SQLite `VACUUM INTO`, which is consistent while the server runs. `manifest.json` records the SHA-256 of each file and the audit chain's verification at backup time. Encrypt backups and keep them with the agency's records schedule; full-disk encryption is assumed on every machine (research 06 §2.5).

Restore: stop the server, copy `gameday.db` and `audit-ed25519.pem` into the data directory (remove any old `-wal` and `-shm` files), start the server, and check `GET /api/v3/audit/verify` (as Records or Admin) returns `ok: true`. If the key was lost, restore from the backup's copy; checkpoints signed by a key the server no longer holds verify only if its key id is in `GAMEDAY_AUDIT_TRUSTED_KEYS`.

## Upgrades

Schema changes are `create ... if not exists` and additive, so a v2 database upgrades in place; v2 saved plans are still read. Back up first. Package files carry a SemVer schema version; a different major version is refused rather than misread.
