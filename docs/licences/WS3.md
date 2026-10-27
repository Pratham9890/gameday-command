# WS3 Platform: dependencies, data and tools

| Item | Version | Licence | Use | Obtained |
| --- | --- | --- | --- | --- |
| [ws](https://github.com/websockets/ws) | ^8.22.0 | MIT | WebSocket hub (`server/src/events/hub.ts`) | npm, `server/package.json` dependency; no dependencies of its own |
| [@types/ws](https://github.com/DefinitelyTyped/DefinitelyTyped) | ^8.18.2 | MIT | Types for `ws` | npm, dev dependency |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | 0.8.15 | MIT | Planned: parsing CAP and KML output in tests (already in the lockfile through PixiJS) | npm, dev dependency |
| NWS API data (api.weather.gov) | live | US Government work, public domain | Weather feed and the recorded test fixtures in `server/src/feeds/fixtures/` (recorded 27 Oct 2026; one alert is a real Texas alert used only for its structure) | HTTPS, with an identifying User-Agent |
| Node.js built-ins (`node:crypto` scrypt, HMAC, Ed25519; `node:sqlite`; `node:http(s)`; `node:dns`) | Node 22.18+ | MIT (Node.js) | Passwords, TOTP, audit signatures, storage, outbound fetch | runtime |
| [mkcert](https://github.com/FiloSottile/mkcert) | — | BSD-3-Clause | Documented tool for local TLS certificates; not bundled | operator installs |
| playwright-core and Chromium (sandbox only) | — | Apache-2.0, BSD-3-Clause | `server/scripts/products-check.ts --browser` print check; not a dependency | sandbox toolchain |

Not added: `openid-client` (MIT) is the intended OIDC library when single sign-on is built; record it here when it lands. Nothing GPL, AGPL or non-commercial.

ICS form layouts follow FEMA's public ICS forms (US Government works); CAP follows the OASIS CAP 1.2 standard; KML follows OGC KML 2.3; GeoJSON follows RFC 7946.
