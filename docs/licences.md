# Licences of dependencies, data, models and assets

Every workstream records what it adds in its own file under [`docs/licences/`](licences/), so merges never conflict. This index is the rule set.

Allowed: MIT, BSD-2/3-Clause, Apache-2.0, ISC, MPL-2.0 (file-level), 0BSD, Unlicense, SIL OFL 1.1 (fonts), CC0, CC BY 4.0 (data, symbols), ODbL (OpenStreetMap data, with attribution; derived databases share-alike).

Flagged and kept out of the shipped app unless a decision record says otherwise: GPL, LGPL (allowed only as an external comparison tool, never linked or bundled), AGPL, any non-commercial or research-only licence, anything with no stated licence.

Each entry lists: name, version, licence, where it is used, how it is obtained (npm, cargo, script, committed), and any attribution text the app must show.

## Already in the repo before v3

| Item | Licence | Use |
| --- | --- | --- |
| React, React DOM 18 | MIT | App UI |
| PixiJS 8 | MIT | Old map renderer (removed in v3) |
| Vite, Vitest, TypeScript | MIT, MIT, Apache-2.0 | Build and test |
| Hono, @hono/node-server | MIT | Server |
| OpenStreetMap extract `world/data/ohio-stadium.osm.json` | ODbL 1.0 | Map geometry; credit "© OpenStreetMap contributors" |
| Kev-4B (optional, run separately) | Apache-2.0 (Kev), base model licence per its card | Fan decisions |
| Hallmark design skill (workspace tool, not shipped) | MIT | UI design rules |

## Per workstream

See `docs/licences/WS1.md` to `docs/licences/WS8.md` as they are added.
