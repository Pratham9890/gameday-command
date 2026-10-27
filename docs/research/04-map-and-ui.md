# 04 — Map stack and professional operations UI

Research note for Gameday Command v3, written 27 October 2026. Versions and licences were read from the npm registry that day. **Measured** figures come from throwaway scripts in `/projects/sandbox/.scratch/map/`, which is outside the repo: `size.mjs` for bundle sizes, `heights.mjs` for building heights, `coords.mjs` for the projection check, and the `pmtiles` CLI 1.31.2. Anything without a source is marked *assumption*.

## Summary

- **Stack.** `maplibre-gl` 6.16.0 (BSD-3) with deck.gl 9.4.0 (MIT) through the new `@deck.gl/maplibre` `MapLibreOverlay`, interleaved, plus `pmtiles` 4.5.0 and `@protomaps/basemaps` 5.7.2 (BSD-3).
  - This costs about +540 KB gzip over today's Pixi build.
  - three.js and CesiumJS are rejected: one has no map, and the other needs an ion token and is twice the size.
- **Offline basemap.** It already exists: `osu.pmtiles` is 4.54 MiB and `columbus.pmtiles` is 29.38 MiB, both Protomaps v4 with OSM data to 26 Oct 2026. OpenFreeMap is only an online fallback, because it has no SLA and caps offline pulls.
- **Building heights.** Only 24% of buildings within 800 m of the stadium have a height. Extrude only those.
- **Coordinates.** Use `METER_OFFSETS` about the grid centre with a 0.998872 scale. Without it the map drifts 1.3 m from the engine (measured).
- **Symbols.** NAPSG (CC BY 4.0) inside ANSI 415 frames. I found no evidence that US police use MIL-STD-2525.
- **UI.**
  - Grey-is-normal operations screen with three alarm priorities, at most one alarm per 10 minutes.
  - Fixed places for perception, comprehension and projection.
  - Provenance tags, a CVD-safe Fruin ramp, and three comparison modes.
  - WCAG 2.2 AA. The DOJ Title II date is now 26 Apr 2027.

# Part A — Map stack

## 1. Rendering engine: MapLibre GL JS + deck.gl vs three.js vs CesiumJS

**Recommendation: MapLibre GL JS 6.16 draws the basemap. deck.gl 9.4 draws our data, through `@deck.gl/maplibre`'s `MapLibreOverlay` in interleaved mode. Basemap tiles are self-hosted PMTiles. Drop PixiJS and the faux-isometric scene from the map path. Do not use three.js or CesiumJS.**

| Package (27 Oct 2026) | Version | Licence | Role |
| --- | --- | --- | --- |
| `maplibre-gl` | 6.16.0 (25 Oct 2026) | BSD-3-Clause | Basemap, camera, 3D building extrusion, controls |
| `@deck.gl/core`, `/layers`, `/geo-layers`, `/mesh-layers`, `/extensions` | 9.4.0 (5 Sep 2026) | MIT | Agents, vehicles, density, routes, symbols |
| `@deck.gl/maplibre` | 9.4.0 | MIT | `MapLibreOverlay` (interleaved or overlaid) |
| `@vis.gl/react-maplibre` (or `react-map-gl`) | 8.1.3 | MIT | React wrapper with a `useControl` hook |
| `pmtiles` | 4.5.0 | BSD-3-Clause | `pmtiles://` protocol for local tile archives |
| `@protomaps/basemaps` | 5.7.2 | BSD-3-Clause | Style layers: light, dark, white, grayscale and black flavours |
| *rejected:* `three` | 0.186.1 | MIT | Renderer only, no map |
| *rejected:* `cesium` | 1.146.0 | Apache-2.0 | Globe engine |

**What changed in 2026.** MapLibre 6.0.0 (22 Jul 2026) is ESM-only and requires WebGL2 ([release](https://github.com/maplibre/maplibre-gl-js/releases/tag/v6.0.0)). deck.gl 9.4 forked `@deck.gl/maplibre` from `@deck.gl/mapbox` to support MapLibre v4.5.1, v5 and v6. It is meant to be the last v9 release before a more disruptive v10 ([what's new](https://deck.gl/docs/whats-new)). `MapboxOverlay` (9.4.0) still exists, but it is now the Mapbox GL path.

**Interleaved vs overlaid.** Interleaved mode draws into MapLibre's WebGL2 context. A `beforeId` slots each deck layer into the style stack, so density sits under street labels and extruded buildings hide agents correctly. Overlaid mode adds a second canvas on top: more robust, but deck objects can never sit behind the basemap's buildings or labels ([integration guide](https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre)). Choose **interleaved**, within its limits ([MapLibreOverlay](https://deck.gl/docs/api-reference/maplibre/overview)):
- One interleaved overlay per map.
- No draping over MapLibre terrain (fine on flat campus ground, *assumption*).
- A custom vertical FOV and camera roll are not synchronised.
- No MSAA, so set 9.4's analytic `antialiasing: true` on path layers.
- Reverse-controlled mode (`DeckGL` as root) blocks MapLibre controls. Use it only if one `Deck` must drive several views.

**Bundle cost (measured).** Method: esbuild 0.28.2, minified ESM, ES2022, CSS and assets excluded, gzip -9 and brotli q11 (`size.mjs`). The "our layers" set is Scatterplot, Path, Icon, Text, Bitmap, SolidPolygon, Polygon, Column, SimpleMesh and Trips, plus the DataFilter, PathStyle and FillStyle extensions, the overlay and the PMTiles protocol.

| Stack | Min KB | Gzip KB | Brotli KB |
| --- | --- | --- | --- |
| PixiJS 8.22 (today) | 516 | 150 | 123 |
| MapLibre only | 1,035 | 284 | 233 |
| MapLibre + deck.gl (our layers) | 2,102 | 582 | 469 |
| …with the `visgl:webgl-only` export condition | 1,929 | 542 | 439 |
| three.js core | 523 | 132 | 109 |
| CesiumJS `Viewer` | 4,196 | 1,135 | 873 |

MapLibre's worker loads separately: 507 KB minified, 145 KB gzip. The `visgl:webgl-only` condition strips WebGPU branches and WGSL shaders ([building apps](https://deck.gl/docs/developer-guide/building-apps)). Set it in Vite's `resolve.conditions`, since deck's WebGPU path is still experimental. Net effect: about +540 KB gzip once Pixi is gone. Lazy-load the map chunk after the shell paints.

**Why not the others.**
- **three.js** is a renderer, not a map. Tiles, projection, label collision, picking and attribution would all have to be rebuilt by us.
- **CesiumJS** stock imagery and terrain come through Cesium ion, which needs an access token; the default token is for evaluation only ([Ion docs](https://cesium.com/downloads/cesiumjs/releases/1.111/Build/Documentation/Ion.html)), which conflicts with the keyless rule. Its JavaScript is twice the size of MapLibre + deck.gl, plus a 23 MB static `Build/Cesium` folder (measured). Globe features buy nothing on a 1.6 km site.

## 2. Keyless basemaps, offline extracts, building heights, imagery

**OpenFreeMap (online fallback only).** The public instance is free, keyless and cookie-free, with no view limits, and commercial use is allowed ([openfreemap.org](https://openfreemap.org/)). Its terms (updated 14 Oct 2026, [ToS](https://openfreemap.org/tos/)):
- As-is, no SLA, may stop without notice; Cloudflare may front it.
- Offline downloads: at most 3,000 tiles or 50 MB each, at most 4 parallel requests, and a unique User-Agent.
- Attribution: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap".

Styles are Positron, Bright, Liberty, Dark and Fiord. Only Liberty has 3D (`building-3d`), and `…/styles/3d` returns 404. The TileJSON serves planet build `20261018_080001_pt` at zoom 0–14 with `render_height`, which OpenMapTiles defines as an approximation ([building.yaml](https://github.com/openmaptiles/openmaptiles/blob/master/layers/building/building.yaml)). In the stadium tile 14/4413/6202, 636 of 780 building rings (82%) carry the 5 m default (measured). No SLA is a bad fit for game day.

**Self-hosted PMTiles (primary, offline).** The Protomaps Basemap is an ODbL Produced Work published as daily planet builds, kept for a week plus the latest of each patch version. Hotlinking is discouraged, so copy to your own storage ([downloads](https://docs.protomaps.com/basemaps/downloads)). `build.protomaps.com/20261026.pmtiles` is 139.19 GB (HTTP HEAD). Existing extracts (measured, `pmtiles show`):

| File | Bounding box (lon/lat) | Zooms | Tiles | Size |
| --- | --- | --- | --- | --- |
| `osu.pmtiles` | −83.06, 39.97 → −82.98, 40.03 | 0–15 | 114 | **4.54 MiB** (4,755,804 B) |
| `columbus.pmtiles` | −83.25, 39.80 → −82.75, 40.16 | 0–15 | 2,748 | **29.38 MiB** (30,803,215 B) |

Both use basemap schema 4.15.2 (planetiler 0.10.2) with OSM data to 26 Oct 2026 04:00 UTC. Layers: `boundaries`, `buildings` (zoom 11–15, `height`, `min_height`), `earth`, `landcover`, `landuse`, `places`, `pois`, `roads`, `water`. To regenerate:

```sh
pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles osu.pmtiles --bbox=-83.06,39.97,-82.98,40.03 --maxzoom=15
pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles columbus.pmtiles --bbox=-83.25,39.80,-82.75,40.16 --maxzoom=15
```

`--dry-run` reports the tile count before downloading. Each extra zoom level roughly doubles the size ([downloads](https://docs.protomaps.com/basemaps/downloads)). Ship the OSU extract in the app. Offer Columbus as an optional download for traffic context. Glyphs and sprites must be local too: the [basemaps-assets](https://github.com/protomaps/basemaps-assets) fonts are OFL (Noto Sans), and the sprites derive from MIT-licensed icons.

**Building heights near Ohio Stadium (measured).** Protomaps takes OSM `height` first. If that is missing it uses `max(levels, 1) × 3 + 2` m, and otherwise it leaves height empty ([Buildings.java](https://github.com/protomaps/basemaps/blob/main/tiles/src/main/java/com/protomaps/basemap/layers/Buildings.java)). Counts are zoom-15 features from `osu.pmtiles`, so a building cut by a tile edge counts twice.

| Radius from 40.0016478, −83.0197398 | Buildings | With height | Median / max | `building:part` with height |
| --- | --- | --- | --- | --- |
| 800 m (the sim grid) | 375 | 91 (24.3%) | 14 m / 74 m | 36 of 39 |
| 2 km | 12,106 | 1,532 (12.7%) | 8 m / 74 m | 858 of 862 |

A live Overpass check agrees: 30 of 32 `building:part` features within 800 m have a height or levels. Ohio Stadium is `way/119153498` (`capacity=104944`, `check_date=2026-09-06`), with the bowl outline at `relation/1639190`. So the bowl and large campus buildings are modelled, but three-quarters of footprints are not. **Rule:** extrude only features with a height; draw the rest flat in a "height unknown" tone, never with an invented height; keep a small sourced override table for structures that block sightlines (*assumption*: about 30).

**Free imagery (optional, off by default).**
- **USGS The National Map `USGSImageryOnly`.** A tile cache to 1:9,028, credited "USDA, USGS The National Map: Orthoimagery. Data refreshed June, 2024", with tile export allowed (measured, service JSON). Its services are free and public domain; USGS asks for a credit naming the U.S. Geological Survey, National Geospatial Program ([USGS FAQ](https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map)).
- **Ohio OGRIP / OSIP.** [`osip_most_current_cache`](https://maps.ohio.gov/image/rest/services/osip_most_current_cache/MapServer) is public leaf-off imagery from 2018–2025, updated 16 Jun 2026. Its licence allows public use at the user's own risk, as-is ([item](https://maps.ohio.gov/portal/sharing/rest/content/items/5b79a50c630348fbb89cfc23573e178c)), and older OSIP metadata calls the orthoimagery public domain ([example](https://gis1.oit.ohio.gov/ZIPARCHIVES/ELEVATION/GRIDTILES/OSIP_AUG_RASTER_DEM/RASTER/N1425315.xml)). But the cache sets `exportTilesAllowed: false` (measured). Stream it online only, and ask OGRIP before packaging any of it offline.

**Control-room styles.** Build two styles of our own from `@protomaps/basemaps` `layers()`, coloured by the app's design tokens: **day/field** from the `light` or `grayscale` flavour, **night/control room** from `dark` or `black`. Desaturate water and parks, thin POIs, and keep street names, building outlines and gate names. Base colours stay out of the data hues (§5, §7).

**ODbL attribution.** Credit "OpenStreetMap", linked to `openstreetmap.org/copyright`, in a map corner, visible without interaction ([OSMF guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)). It may collapse after 5 s or on interaction if it stays findable, for example behind an (i) button. "© OpenStreetMap contributors" is still acceptable, and static images and exported briefings follow the same rules. Add OpenMapTiles when OpenFreeMap is used and USGS when imagery is on. On a video wall the credit must stay legible at viewing distance.

## 3. Rendering our data in deck.gl

**World → map coordinates (exact).** [`world/src/osm/raster.ts`](../../world/src/osm/raster.ts) `makeProjection` is a local equirectangular projection:
- 111,320 m per degree of latitude;
- `111,320 × cos(lat₀)` m per degree of longitude;
- the grid origin at `centre − radiusM`.

Inverting it for world metres (x east, y south, from the NW corner):

```ts
const LAT0 = 40.0016478, LON0 = -83.0197398, R = 800, M = 111_320;
const COS0 = Math.cos(LAT0 * Math.PI / 180);         // 0.766025957 → 85,274.009 m per degree of longitude
const lng = LON0 + (x - R) / (M * COS0);              // = LON0 + (x - 800) * 1.172690256e-5
const lat = LAT0 - (y - R) / M;                       // = LAT0 - (y - 800) * 8.983111750e-6
// NW corner (0,0) = [-83.0291213, 40.0088343]; SE corner (1600,1600) = [-83.0103583, 39.9944613]
```

**For binary layers, use `COORDINATE_SYSTEM.METER_OFFSETS`** about the grid centre (`coordinateOrigin: [LON0, LAT0, 0]`). Pack positions as `[k·(x − 800), −k·(y − 800)]`, with `k = (40.03e6 / 360) / 111,320 = 0.998872`.
- **Why `k`.** deck.gl assumes a 40.03e6 m Earth circumference (`@math.gl/web-mercator` 4.1.0); the engine assumes 111,320 m per degree. Without `k`, offsets drift up to **1.31 m** from the engine at the grid edge (2.56 m with a NW-corner origin). With `k` the worst gap is 0.09 m (measured, `coords.mjs`).
- **Where.** Apply `k` and the y flip while packing frames. A mirroring `modelMatrix` would also flip mesh winding and heading.
- **Not Float32 lng/lat.** It steps in 0.65 m (longitude) and 0.42 m (latitude) increments here (derived). Use Float64Array if you must send degrees.
- **Heading.** Engine heading is clockwise from east with y south, so deck yaw is `−heading × 180/π`. Check the sign with a test arrow (*assumption*).

**Agents (up to 100k).**
- **Layer.** A `ScatterplotLayer` fed only binary attributes (`data: {length, attributes: {getPosition: {value: Float32Array, size: 2}, getFillColor: {value: Uint8Array, size: 4, normalized: true}}}`), transferred from the worker. deck.gl recommends this for animation because it skips CPU attribute generation ([performance](https://deck.gl/docs/developer-guide/performance)).
- **Look.** Radius about 0.3 m with `radiusMinPixels: 1.5`; colour by state through a palette; `DataFilterExtension` hides states on the GPU.
- **Motion.** Built-in attribute transitions interpolate on the GPU by index, but run on wall-clock durations ([transitions](https://deck.gl/docs/developer-guide/animations-and-transitions)). For a scrubbable, deterministic timeline, subclass the layer with an `instanceNextPositions` attribute and a timeline-driven `frameT` uniform, and `mix()` them in the vertex shader.
- **Frame spacing.** A walker covers about 20 m in 15 s (*assumption*: 1.3 m/s), so straight lerps cut corners. Interpolate only between display frames 1–3 s apart; keep 15 s frames for scrubbing.
- **Bandwidth.** About 0.9 MB per frame at 100k agents (8 B position + 1 B state).

**Vehicles (5k).** In 3D, a `SimpleMeshLayer` with one unit cube (`CubeGeometry`, luma.gl): `getScale [length, width, height]` per kind, `getOrientation [0, yaw, 0]`, `getColor` by state, all as binary attributes. In 2D plan view, an `IconLayer` arrow with `getAngle` and `billboard: false` is cheaper and clearer.

**Density grid (800 × 800 × 2 m).**
- **Default: a draped `BitmapLayer`** with `bounds [−83.0291213, 39.9944613, −83.0103583, 40.0088343]`, nearest-neighbour sampling, placed `beforeId` the first label layer, transparent below LoS C.
- **Colouring.** The worker maps the Float32 grid through a 256-entry lookup table into a 2.56 MB RGBA texture. Alternatively the shader samples a float texture plus a ramp, so thresholds change without repacking.
- **3D.** A `ColumnLayer` over 640k cells is unreadable and costly. Aggregate to 10 m cells (25,600), draw only cells above LoS D, label it "height exaggerated", and keep it a toggle.
- **Limit lines.** The 2.15 and 4 p/m² contours as `PathLayer` lines, from marching squares in the worker.

**Routes, symbols, zones, cameras.**
- **Routes.** `PathLayer` in metres with `PathStyleExtension` (dashed = proposed, solid = active; 9.4 added `dashMode` and `dashUnits`, [what's new](https://deck.gl/docs/whats-new)). Flow along routes uses a `TripsLayer` on the same timeline.
- **Symbols and labels.** `IconLayer` from a prebuilt SVG atlas (§4), sized in pixels. `TextLayer` with `CollisionFilterExtension` and a local Noto Sans font.
- **Zones and closures.** `SolidPolygonLayer` / `PolygonLayer`. 9.4's `FillStyleExtension` draws hatch and dot patterns in the shader, which marks forecast or uncertain areas without a texture atlas.
- **Camera fields of view.** One wedge polygon per camera (position, bearing, horizontal FOV, range), low fill, with coverage gaps hatched.

**Picking.** Enable `pickable` only on interactive layers. 9.4 picks by `instance_index`, which uses less memory than colour buffers. Limits are 16M items per layer and 256 pickable layers ([performance](https://deck.gl/docs/developer-guide/performance)). Agents are never picked as individuals: a click on the crowd returns the cell or zone readout (density, LoS, trend), so the no-identities rule shows in the UI.

**Comparing three plans.**

| Option | For | Against |
| --- | --- | --- |
| **Three synced MapLibre maps** (one interleaved overlay each, cameras synced with `jumpTo` on `move`) | Keeps the styles, labels and 3D buildings. Each plan's worker feeds its own map. Already the current `ComparisonMaps` mental model. | Three WebGL contexts and three copies of the tile cache (small with the OSU extract). |
| One `Deck` with three `MapView`s and `layerFilter` by view id ([views](https://deck.gl/docs/developer-guide/views)) | One context | MapLibre cannot draw a basemap per view. Tile layers in several views need one instance each and are expensive. The multi-canvas option in 9.4 is experimental. |

**Recommendation:** three synced maps for small multiples, plus two single-map modes: swipe (A | B) and difference (A − B, diverging ramp) (§6).

**Performance limits.** deck.gl's guidance: basic layers stay near 60 FPS up to about 1M items on a 2015 MacBook Pro and fall to 10–20 FPS near 10M. Cost scales with vertices and overdraw (a 5 px dot shades about 100 pixels). High-DPI rendering multiplies fragments by four, so cap `useDevicePixels` on large walls. About 100 layers is fine, and phones are memory-sensitive ([performance](https://deck.gl/docs/developer-guide/performance)). Three plans × 100k agents is 300k points, well inside these limits. That is an *assumption* until measured on the command-post Mac and a mid-range Windows laptop.

## 4. Emergency-management map symbology

**ANSI INCITS 415-2006**, *Homeland Security Mapping Standard – Point Symbology for Emergency Management*, was written by the FGDC Homeland Security Working Group. It was approved in July 2006, and the ANSI store now lists it as reaffirmed in 2022 ([ANSI](https://webstore.ansi.org/standards/incits/incits4152006r2022)). How it is built ([FGDC FAQ](https://www.fgdc.gov/hswg/ref_pages/SymbolFAQ_ref.htm), [background](https://www.fgdc.gov/HSWG/ref_pages/SymbologyBackground_ref.htm)):
- **Four categories:** incidents, natural events, operations and infrastructures.
- **Frames:** incidents are diamonds, infrastructure symbols are rectangles, and operations symbols are circles.
- **Status:** a damage and operational status (open, closed, partial, destroyed) is carried by colour plus frame line patterns.
- **Scale:** the symbols are designed for incident and community scale. Below about 10–12 pt the FAQ suggests using the bare category frame with a label.
- **No letters or numbers** inside symbols, except H for hospital. ICS symbols are kept by placing them inside the right frame.

**NAPSG Foundation** publishes, with DHS, an incident symbology framework, guideline and symbol set as SVG, PNG, TrueType and ArcGIS styles under **CC BY 4.0**, commercial use included ([NAPSG](https://www.napsgfoundation.org/symbology)). FEMA's IPAWS symbols use NAPSG's reserved triangle for public alerts ([FEMA tip](https://www.fema.gov/sites/default/files/documents/fema_tip-36-symbology.pdf)). Trap: the GitHub copy ([DHS-Symbol-Server](https://github.com/NAPSG/DHS-Symbol-Server)) has a DoD "Distribution Statement C" notice in `LICENSE.txt`. Take the SVGs from NAPSG's Symbol Library, not that repo.

**ICS facility symbols** (command post, staging, base, camp, helibase, division and branch boundaries) are letters in simple shapes, from field guides such as the [ICS map display symbology sheet](https://filelib.wildlife.ca.gov/Public/OSPR/rimai/2014_EROS/EROS_CD/FederalGovernment/USCG/ICS/ToolsSupplies/ICS%20Map%20Display%20Symbology.pdf). The FGDC FAQ calls them common wildland-fire practice, not a standard.

**MIL-STD-2525 / APP-6** unit symbols are military (DoD, NATO). Some European police use unit-style symbols; one tool's "civil symbols" follow Swiss police symbology ([map.army](https://www.map.army/doc/en/options/general/)). I found no evidence that US municipal or university police use 2525 unit symbols; US public-safety guidance points to ANSI 415, NAPSG and ICS. **Do not use 2525.** If a federal partner ever needs it, `milsymbol` 3.0.4 (MIT) renders it.

**Recommended set:** NAPSG/ANSI glyphs in ANSI frames. Status is shown by frame pattern and a text label, never by colour alone.

| Object | Frame and glyph | Status encoding | Layer |
| --- | --- | --- | --- |
| Officer (individual) | Small operations circle in one "police" hue; call sign label from zoom 17 | Filled = on post; outline = moving; dashed = unavailable | `IconLayer` |
| Unit or team (bike, mounted, K9, traffic) | Operations circle + unit glyph + headcount | Same | `IconLayer` |
| Fixed post | Operations circle with a pin tail | Staffed / unstaffed (outline) | `IconLayer` |
| Barricade / fence | Line: short alternating dashes (*assumption*: MUTCD-like) | Planned = dashed; in place = solid | `PathLayer` |
| Road closure | Line with end bars + infrastructure rectangle at each end | Closed / partial / open (frame pattern) | `PathLayer` + `IconLayer` |
| Aid station | Operations circle, NAPSG first-aid glyph | Open / at capacity | `IconLayer` |
| Staging area | ICS staging symbol in an operations circle | Count of units staged | `IconLayer` + polygon |
| Command post (ICP) | ICS ICP symbol in an operations circle; one per incident | – | `IconLayer` |
| Camera | Infrastructure rectangle + camera glyph + FOV wedge | Live / stale / offline (frame pattern + age label) | `IconLayer` + `SolidPolygonLayer` |
| Incident (surge, package, lightning) | Incident diamond + glyph | Active / contained / closed | `IconLayer` |
| Gate | Infrastructure rectangle + gate number | Open / partial / closed | `IconLayer` |

Record the NAPSG CC BY 4.0 attribution in the About panel and in `docs/licences`. The symbol atlas is a dataset under the brief's licence rule.

# Part B — Professional operations UI

## 5. High-performance HMI, alarms, situation awareness, stress

**ISA-101.** ANSI/ISA-101.01-2015, *Human Machine Interfaces for Process Automation Systems*, defines a lifecycle for operator displays. ISA-TR101.01-2022 adds guidance on writing an HMI philosophy ([ISA](https://www.isa.org/standards-and-publications/isa-standards/isa-101-standards)). The "high-performance HMI" practice behind it, as summarised in a PAS white paper hosted by ISA ([Hollifield, PAS 2012](https://www.isa.org/getmedia/06130a38-f7af-4b35-8c9c-2c34f25c1977/The-High-Performance-HMI-Overview-v2-01.pdf)): grey backgrounds to cut glare; a small, consistent palette, with bright colour reserved for abnormal states and never the only cue; no decorative animation; embedded trends showing normal and abnormal ranges; analog indicators that place a value against its normal band; and a display hierarchy from overview to detail. Its anti-patterns (saturated 3-D vessels, red/green on/off colouring, number-heavy schematics) have parallels in today's app: the game-like close-up, team colours and three duplicate density keys.

**Alarms.**
- **ISA-18.2.** ANSI/ISA-18.2-2016 is the alarm lifecycle standard ([ANSI](https://webstore.ansi.org/standards/isa/ansiisa182016)). A summary by Siemens says it recommends no more than three or four priorities, with no more than 5% of alarms configured high. It tracks floods as the share of 10-minute windows with more than ten alarms ([Siemens](https://cache.industry.siemens.com/dl/files/836/109772836/att_1002094/v1/WP_Alarm_Management_ISA_18.pdf)).
- **EEMUA 191.** Now in its 4th edition, November 2024 ([contents](https://www.eemua.org/getattachment/9d3f8071-55c3-49bf-a74a-3bf6ad4a2e0f/Contents-EEMUA-Publication-191-Edition4-November-2024.pdf)).
- **Rate targets.** The UK regulator's summary of EEMUA ([HSE CHIS6](https://www.hse.gov.uk/pubns/chis6.pdf)):
  - a long-run average of at most one alarm per 10 minutes in normal operation;
  - at most ten alarms shown in the first 10 minutes of a major upset;
  - about three priorities, split roughly 5% high, 15% medium and 80% low;
  - priority set by the consequence of *not* responding.
- **Why it matters.** At Milford Haven, two operators faced 275 alarms in the 11 minutes before the 1994 explosion (same source).

**For Gameday,** an *alarm* is a condition that needs the commander's decision (for example, density above 4 p/m² sustained for 60 s in a zone); everything else is a log *event*. Thresholds depend on phase, so the expected kickoff surge does not fire alarms. Floods are grouped by sector, first alarm first.

**Situation awareness.** Endsley defines SA in three levels ([Endsley 1995](https://doi.org/10.1518/001872095779049543)):
1. **Perception** of the elements in the environment.
2. **Comprehension** of what they mean.
3. **Projection** of their status in the near future.

Give each level a fixed place: the map and status board for level 1, derived meaning (LoS and queue time against target, why a cell is red) for level 2, and the timeline's forecast lane, labelled as an assumption, for level 3. Endsley's design method also lists "SA demons" to design against, including attentional tunnelling, data overload, misplaced salience and out-of-the-loop automation ([Endsley 2012](https://doi.org/10.1201/b11371)).

**Stress and alert fatigue.** Stress narrows attention, so keep critical items in fixed places, avoid modal dialogs during a run, and prefer undo to confirmation chains (*assumption*: standard human-factors practice). The Joint Commission estimates that 85–99% of clinical alarm signals need no intervention, and that the noise desensitises staff ([Sentinel Event Alert 50](https://www.jointcommission.org/resources/sentinel-event/sentinel-event-alert-newsletters/sentinel-event-alert-issue-50-medical-device-alarm-safety-in-hospitals/)). Every Gameday alarm should trace to a rationalised rule (cause, consequence, decision asked), and the alarm rate per run should be tracked as a quality metric.

## 6. Patterns from mature operations tools

**What the mature tools agree on.**
- **Esri ArcGIS Dashboards** separates *attended* views (a desktop, interactive) from *unattended* ones (large screens in operations centres, passive). It builds a separate mobile view, and asks a dashboard to pull attention to where it is needed and show what matters most first ([Esri](https://doc.arcgis.com/en/dashboards/latest/get-started/what-is-a-dashboard.htm)).
- **FAA air traffic facilities.**
  - Critical colour must be paired with a second cue such as blinking.
  - Red (warning) and yellow (caution) are conventions that may not be broken.
  - Pure blue must not be used for text, small symbols or backgrounds ([FAA order JO 7210.3, ch. 3 §9](https://www.faa.gov/air_traffic/publications/atpubs/foa_html/chap3_section_9.html)).
- **Process and utility control rooms** follow ISA-101/18.2 (§5).
- **UK sports-ground control points** (Green Guide, SG03 Annex C) expect wall space for a venue plan and deployment boards for stewards, police and medical, plus turnstile counts ([SGSA](https://sgsa.org.uk/wp-content/uploads/2021/09/Annex-C-Control-points.pdf)). That is the status board, on paper.

**Layout for v3 (one screen, map-centric).**
- **Top bar:** clock, phase, active incident, weather, plan selector, and the "simulated, assumptions" badge.
- **Map:** fills the rest.
- **Left dock, status board:** alarms (three priorities), then sectors and gates (LoS, queue time, trend), then units. Clicking a row centres the map.
- **Right dock, inspector:** the selected zone, gate, unit or plan step.
- **Bottom, timeline:** now line, event and plan-step markers, a forecast lane with an uncertainty band, and a keyboard-steppable scrubber.

Docks collapse to rails.

**Modes.** *Video wall*: unattended and read-only, type and symbols 1.5–2× larger (*assumption*: tune on site), no hover-only content. *Briefing*: a plan's steps on the map. *Comparison*: see below.

**Keyboard.** One command palette (Ctrl/⌘ K) for every action, using the button names. Single keys cover the timeline (Space, ← →), layers (number keys), next alarm (N) and acknowledge (A, with undo), all listed on a `?` sheet. No single key changes a plan; plan changes need palette confirmation.

**Comparing scenarios.** Gleicher et al.'s taxonomy names three strategies: juxtaposition (side by side), superposition (overlay) and explicit encoding (computing the difference) ([Gleicher et al. 2011](https://doi.org/10.1177/1473871611416549)).

| Technique | Use when | Gameday form |
| --- | --- | --- |
| Small multiples | 2–3 plans; a whole-site picture | Three synced maps, shared camera, same ramp and legend, plan letter in each corner |
| Swipe | Two plans; local detail | A draggable divider ([Esri Swipe](https://doc.arcgis.com/en/experience-builder/latest/configure-widgets/swipe-widget.htm)) with a keyboard alternative |
| Difference map | "Where does B help or hurt versus A?" | A − B density on a diverging ramp, with a neutral zone at about 0 |
| Scored table | The final call | Outcomes and costs per plan, with no "winner" wording |

## 7. Density and risk visualisation

**Ramps, not traffic lights.** About 1 in 12 men have a colour vision deficiency, and red–green is the most common type ([NEI](https://www.nei.nih.gov/learn-about-eye-health/eye-conditions-and-diseases/color-blindness)). Rainbow and red–green maps distort data and exclude CVD readers ([Crameri et al. 2020](https://doi.org/10.1038/s41467-020-19160-7)). *cividis* was optimised to look nearly the same to people with and without CVD ([Nuñez et al. 2018](https://doi.org/10.1371/journal.pone.0199239)). **Rule:**
- Density uses one perceptually uniform sequential ramp (cividis or a viridis-family ramp), stepped at Fruin's walkway thresholds.
- Red is kept for alarms only (§5).
- In daylight style high density is darker. In night style it is brighter.

**Fruin LoS legend**, one key shown once. Thresholds are from [Fruin 1971](https://onlinepubs.trb.org/Onlinepubs/hrr/1971/355/355-001.pdf) as tabulated in `01-domain-practice.md` §1.4:

| LoS | Walkway density (p/m²) | Map treatment |
| --- | --- | --- |
| A–B | ≤ 0.43 | Transparent: the base stays quiet |
| C | 0.43–0.72 | Ramp step 1 |
| D | 0.72–1.08 | Ramp step 2 |
| E | 1.08–2.15 | Ramp step 3 |
| F | > 2.15 | Ramp step 4, plus a contour line |
| Danger line | ≥ 4 (Gameday's current line) | A contour that raises an alarm if sustained (§5) |

Label the legend "LoS (Fruin, walkways)". Stairs and queues have their own thresholds, and the legend must say which type of space a zone is.

**Uncertainty.** MacEachren et al. tested which visual variables people read as uncertainty and found *fuzziness* and *location* the most intuitive, with *value* and *saturation* also workable ([MacEachren et al. 2012](https://doi.org/10.1109/TVCG.2012.279)). A systematic review of geospatial uncertainty-display user studies is in [Kinkeldey et al. 2014](https://doi.org/10.1179/1743277414Y.0000000099). **Rule:**
- Show forecasts and video estimates with a visible spread: p10–p90 bands on timeline charts, and hatched or softened cells on the map where the spread is wide.
- Never draw a crisp single line for a forecast.

**Provenance.** Each source gets one fixed visual treatment and a text tag:

| Source | Treatment | Tag text (plain language) |
| --- | --- | --- |
| Simulated (engine run) | Default ramp, solid | "Simulated: fan behaviour is an assumption" |
| Observed / estimated (video, counts) | Ramp inside a solid outline + "± range, age" | "Estimated from camera 4, ±15%, 20 s ago" |
| Forecast (ensemble) | Ramp with `FillStyleExtension` hatch; fan chart on timeline | "Forecast, 30 runs, next 15 min" |

The brief requires these labels. The figures in the tag examples are illustrations, not data.

## 8. Field and mobile use

**Targets.**
- WCAG 2.2's AA minimum is 24 × 24 CSS px (SC 2.5.8). The AAA level is 44 × 44 px (SC 2.5.5) ([WCAG 2.2](https://www.w3.org/TR/WCAG22/)).
- For one-handed thumb use, Parhi et al. found 9.2 mm targets enough for discrete taps and 9.6 mm for serial taps ([Parhi et al. 2006](https://www.microsoft.com/en-us/research/wp-content/uploads/2006/01/parhi-mobileHCI06.pdf)).
- With gloves, first-try accuracy drops. In a small military study (n = 6), targets sized to MIL-STD-1472 produced no wrong activations, gloved or bare-handed ([Touch Zone Sizing, 2016](https://link.springer.com/chapter/10.1007/978-3-319-40406-6_7)).

**Rule:** primary touch targets are at least 48 × 48 CSS px with 8 px gaps (*assumption*: about 10 mm on current phones; verify per device), and destructive actions need hold-to-confirm or undo.

**One hand.** In 1,333 street observations, 49% of people touching their phone used one hand, 36% cradled it and 15% used two hands ([Hoober 2013](https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php)). Put officer-mode actions in a bottom bar within thumb reach. The map stays pannable with one finger, and drag on the map is never the only way to do something (SC 2.5.7).

**Sunlight and night.**
- **Outdoors:** the light style, with text at 7:1 contrast where possible (WCAG's AAA level 1.4.6) and never below 4.5:1.
- **Night mode:** the dark style at reduced luminance, with no large white fills and the same symbol shapes.
- Readability on real devices in sun is an *assumption* to test on site.

**Offline-first PWA.**
- **What is cached.** The service worker caches the app shell, `osu.pmtiles` (4.54 MiB), glyphs, sprites and the symbol atlas.
- **Persistence.** Call `navigator.storage.persist()`.
- **Quotas** ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)):

  | Browser | Quota per origin |
  | --- | --- |
  | Chromium | Up to 60% of disk |
  | Firefox, best-effort | The smaller of 10% of disk and 10 GiB |
  | Firefox, persistent | 50% of disk |
  | Safari 17+ | About 60% of disk (Home Screen web apps get the browser quota) |

- **The Safari risk.** With tracking prevention on, Safari deletes script-created data for an origin with no user interaction in seven days of browser use. Officers' devices must install the app to the Home Screen and re-verify the cache before each game day.

## 9. Accessibility: WCAG 2.2 AA and the DOJ ADA Title II rule

**WCAG 2.2.** First a W3C Recommendation in October 2023; the current version is dated 12 December 2024 ([WCAG 2.2](https://www.w3.org/TR/WCAG22/)).
- **New at A/AA** ([what's new](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/)):
  - 2.4.11 Focus Not Obscured (Minimum), AA
  - 2.5.7 Dragging Movements, AA
  - 2.5.8 Target Size (Minimum), AA
  - 3.2.6 Consistent Help, A
  - 3.3.7 Redundant Entry, A
  - 3.3.8 Accessible Authentication (Minimum), AA
- **Removed:** 4.1.1 Parsing.
- **What bites a map tool:**
  - Docked panels and toasts must not cover the focused element (2.4.11).
  - The timeline scrubber, swipe divider and map pan need non-drag alternatives (2.5.7).
  - Sign-in must not rely on a memory test (3.3.8).
  - Colour may not be the only cue (1.4.1).
  - Symbols, density steps and focus rings need 3:1 non-text contrast (1.4.11).
  - New alarms are announced through an `aria-live` region, assertive only for high priority (4.1.3).
  - Every map object also appears in the keyboard-navigable status board, the map's text alternative (1.1.1).

**DOJ ADA Title II rule.**
- **The rule.** The final rule, published 24 April 2024, requires state and local governments' web content and mobile apps to meet **WCAG 2.1 Level AA** ([Federal Register](https://www.federalregister.gov/documents/2024/04/24/2024-07758/nondiscrimination-on-the-basis-of-disability-accessibility-of-web-information-and-services-of-state-and-local-government-entities)). That includes content a contractor or other partner provides on their behalf ([ADA.gov fact sheet](https://www.ada.gov/resources/2024-03-08-web-rule/)).
- **New dates.** An interim final rule published **20 April 2026** moved the compliance dates ([IFR](https://www.ada.gov/assets/pdfs/2026-ifr.pdf)):
  - entities serving 50,000 people or more: from 24 April 2026 to **26 April 2027**;
  - smaller entities and special district governments: to **26 April 2028**.
- **Exceptions** are narrow: archived content, preexisting documents, third-party posts, individualised password-protected documents and preexisting social media.
- **What this means for us.** Ohio State (a state university) and the City of Columbus are Title II entities above 50,000, so **26 April 2027** is the date if they deploy the tool. Whether an internal command tool counts as content "provided or made available" under the rule, or falls under employment law, is a question for agency counsel. It is not settled here.
- **Recommendation:** build to WCAG 2.2 AA, which covers 2.1 AA except the removed 4.1.1, and test on every release.

## 10. Design principles for Gameday Command v3

1. **The map is the instrument.** One map-centric screen with docked panels; nothing floats over the map centre (§6).
2. **Grey means normal.** Colour marks abnormal states and the active plan; red means an alarm and nothing else (§5).
3. **Every number says where it came from:** simulated, estimated or forecast, with a time and a range (§7).
4. **Few alarms, three priorities.** At most one per 10 minutes in normal play; anything needing no decision goes to the log (§5).
5. **Show tradeoffs, never orders.** For example: "B: Gate 10 queue 6 min shorter; 2 more officers committed" (brief).
6. **SA levels in fixed places.** The map shows what and where, the status board what it means, the timeline what comes next (Endsley).
7. **Compare like with like.** Same camera, ramp and legend across plans, plus a difference map (Gleicher).
8. **Shape, pattern and label before colour.** It must still read in a greyscale print (§4, §7).
9. **Calm motion.** Only the crowd, vehicles and a new alarm's onset move; reduced motion is honoured.
10. **Built for the field.** 48 px targets, one-handed officer actions, day and night styles, offline extract (§8).
11. **Keyboard first.** Every action is in the palette; frequent ones have keys; names match everywhere (§6).
12. **One vocabulary, one legend.** Plain police language, never internal names ("Kev", "1 dot = 5 fans"); each key shown once.
13. **No identities on the map.** Picking returns cells, zones and units, never people (brief).
14. **Honest credits.** OSM, OpenMapTiles, USGS and NAPSG credits are always findable and legible (§2, §4).

**Map layers, bottom to top:**

| # | Layer | Implementation | Default | Pickable |
| --- | --- | --- | --- | --- |
| 1 | Basemap (day / night) | MapLibre style from `@protomaps/basemaps`, `osu.pmtiles` | On | No |
| 2 | Imagery (USGS / OSIP) | MapLibre raster source | Off | No |
| 3 | Zones: sectors, perimeters, security zones | `SolidPolygonLayer` (+ outline `PathLayer`) | On | Yes |
| 4 | Density | `BitmapLayer` (2D, `beforeId` labels); 10 m `GridCellLayer` above LoS D (3D toggle) | On | Yes (cell readout) |
| 5 | Forecast / uncertainty | `SolidPolygonLayer` + `FillStyleExtension` hatch | With forecast | No |
| 6 | Buildings 3D | MapLibre `fill-extrusion` where `height` exists; others flat, "height unknown" tone | 3D view | No |
| 7 | Closures and barricades | `PathLayer` + `PathStyleExtension` | On | Yes |
| 8 | Routes (proposed / active) and flow | `PathLayer` (dashed / solid), `TripsLayer` | On | Yes |
| 9 | Vehicles | `IconLayer` arrows (2D), `SimpleMeshLayer` boxes (3D), binary attributes | On | Yes (kind, state) |
| 10 | Crowd | `ScatterplotLayer` + frame-lerp subclass, METER_OFFSETS, binary | On from zoom 16 (*assumption*) | No |
| 11 | Camera FOV | `SolidPolygonLayer` wedges + coverage-gap hatch | Off (on in video mode) | Yes |
| 12 | Officers, units, posts, aid, staging, ICP, gates | `IconLayer`, NAPSG/ANSI atlas | On | Yes |
| 13 | Incidents and alarms | `IconLayer` diamonds + priority ring (shape + text) | On | Yes |
| 14 | Labels | MapLibre symbol layers on top; deck `TextLayer` + `CollisionFilterExtension` | On | No |
| 15 | Selection, measure, swipe divider | `PathLayer` / `ScatterplotLayer` / DOM | On demand | – |

## 11. Requirements

| ID | Requirement | Why | Source |
| --- | --- | --- | --- |
| MAP-01 | `maplibre-gl` ^6.16 + `@deck.gl/*` ^9.4 via `MapLibreOverlay` (interleaved); remove PixiJS from the map path | Labels and 3D occlusion; permissive licences | §1 |
| MAP-02 | Build with the `visgl:webgl-only` condition; lazy-load the map chunk | −40 KB gzip; shell paints first | deck.gl, measured |
| MAP-03 | Ship `osu.pmtiles` with local glyphs and sprites; no runtime tile host | Offline game day; OpenFreeMap has no SLA | Protomaps, OFM ToS |
| MAP-04 | Script extract regeneration with a pinned build date and a manifest (source, ODbL) | Reproducible, auditable data | Protomaps |
| MAP-05 | OpenFreeMap online fallback only; any offline pull ≤ 3,000 tiles / 50 MB, ≤ 4 requests, own User-Agent | Terms of service | OFM ToS |
| MAP-06 | Two first-party styles (day, night) from `@protomaps/basemaps`, coloured by design tokens | Quiet base, distinct data hues | §2, ISA-101 |
| MAP-07 | Linked "© OpenStreetMap" credit visible in every view, export and wall mode; other credits when used | ODbL safe harbour | OSMF |
| MAP-08 | Extrude buildings only where `height` exists; others flat, "height unknown"; sourced override table | Only 24% have heights | measured |
| MAP-09 | Imagery off by default; USGS credited; OSIP streamed online only unless OGRIP approves | Public domain vs `exportTilesAllowed: false` | USGS, OSIP |
| MAP-10 | One `worldToMap` module (engine inverse + METER_OFFSETS with k = 0.998872); test corners within 0.1 m | 1.3 m drift otherwise | measured |
| MAP-11 | Agents and vehicles rendered from transferred typed-array attributes only | Main thread free; deck.gl guidance | deck.gl perf |
| MAP-12 | GPU frame interpolation driven by the timeline, only between display frames ≤ 3 s apart | Deterministic scrubbing; no corner-cutting | §3 |
| MAP-13 | Density as a draped `BitmapLayer`, nearest sampling, LoS-stepped CVD-safe ramp; 3D only as 10 m toggle | Legible, cheap, honest | §3, §7 |
| MAP-14 | Crowd not pickable per agent; picks return cell or zone statistics | No identities | brief |
| MAP-15 | Plan comparison by three synced maps, swipe and difference map; same ramp and legend | Fair comparison | Gleicher, deck.gl views |
| MAP-16 | NAPSG symbols (CC BY 4.0) in ANSI 415 frames; no MIL-STD-2525; licence recorded | Familiar to US public safety | §4 |
| MAP-17 | Camera FOV wedges and coverage gaps as a layer, on in video mode | Shows where estimates come from | §3 |
| MAP-18 | Budget: 3 maps × 100k agents + 5k vehicles at ≥ 30 FPS (*assumption*) on target machines; cap DPR on walls | Real hardware, not guesses | deck.gl perf |
| UI-01 | Map-centric screen: top bar, left status board, right inspector, bottom timeline; replaces the six-tab rail | SA levels in fixed places | §6, Endsley |
| UI-02 | Greys for normal; colour for abnormal and active plan; red for alarms only; no team colours in ops view | Salience where it matters | ISA-101, FAA |
| UI-03 | Every status carries shape, pattern or text as well as colour | CVD, print, wall | WCAG 1.4.1, FAA |
| UI-04 | Three alarm priorities by consequence; alarms only for decisions; one rationalised rule per alarm | Prevents floods and fatigue | ISA-18.2, HSE |
| UI-05 | Alarm-rate metric per run: ≤ 1 per 10 min normal, ≤ 10 in the first 10 min of an incident; group floods by sector | Measurable alarm quality | HSE/EEMUA |
| UI-06 | Phase-aware alarm thresholds (ingress, game, egress, incident) | No nuisance alarms at kickoff | Siemens/ISA-18.2 |
| UI-07 | Provenance tag on every number and layer: simulated / estimated / forecast, with age and range | Brief's honesty rule | brief, §7 |
| UI-08 | Forecasts show spread (bands, hatching), never one crisp line | Uncertainty read correctly | MacEachren 2012 |
| UI-09 | One docked Fruin LoS legend naming the type of space | Today's key appears three times | Fruin, audit |
| UI-10 | Descriptive tradeoff copy; a lint test flags imperative orders | The commander decides | brief |
| UI-11 | Plain police vocabulary; internal names banned from copy | Jargon in today's UI | audit |
| UI-12 | Command palette (Ctrl/⌘ K), documented keys, `?` sheet; plan edits need palette confirmation | Speed without accidents | §6 |
| UI-13 | Video-wall mode: unattended, read-only, larger type, no hover-only content | Ops-centre screens | Esri |
| UI-14 | Timeline: now line, events, plan steps, forecast lane; keyboard and non-drag control | Projection level; SC 2.5.7 | Endsley, WCAG |
| UI-15 | WCAG 2.2 AA, tested each release (automated + keyboard + screen reader) | Law and users | WCAG 2.2, DOJ |
| UI-16 | Status board is the map's text alternative; selection syncs both ways | SC 1.1.1, 2.1.1 | WCAG |
| UI-17 | New alarms announced via `aria-live`; assertive only for high priority | SC 4.1.3 without noise | WCAG |
| UI-18 | Touch targets ≥ 48 px with 8 px gaps in officer mode; ≥ 24 px everywhere | Gloves, one hand | WCAG 2.5.8, Parhi |
| UI-19 | Officer mode: bottom action bar in thumb reach; no drag-only actions | 49% one-handed use | Hoober, WCAG |
| UI-20 | Day, night and wall themes from one token set; text ≥ 4.5:1 (aim 7:1 outdoors); non-text ≥ 3:1 | Sunlight, night, Floor rule 1 | WCAG, Hallmark |
| UI-21 | Offline PWA: precache shell, tiles, glyphs, sprites, atlas; `persist()`; pre-game cache check | Safari's 7-day deletion | MDN |
| UI-22 | Motion only for crowd, vehicles and new-alarm onset; honour reduced motion | Calm screen | PAS, Hallmark Floor 7 |
| UI-23 | Track Title II dates: WCAG 2.1 AA by 26 Apr 2027 for large entities; scope question to counsel | Legal exposure | DOJ IFR 2026 |
| UI-24 | Remove demo-only UI (demo sign-in, role switch, synthetic banner) from operating builds | Professional use | audit |

## 12. Sources

All pages were accessed 26–27 October 2026; publication or update dates are given where they matter.

**Map stack**
- [MapLibre GL JS v6.0.0 release notes](https://github.com/maplibre/maplibre-gl-js/releases/tag/v6.0.0) (22 Jul 2026); version 6.16.0 per npm (25 Oct 2026)
- [deck.gl what's new (v9.4, 5 Sep 2026)](https://deck.gl/docs/whats-new)
- [deck.gl: using with MapLibre](https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre)
- [deck.gl: MapLibreOverlay API](https://deck.gl/docs/api-reference/maplibre/overview)
- [deck.gl: building apps and bundle size](https://deck.gl/docs/developer-guide/building-apps)
- [deck.gl: performance](https://deck.gl/docs/developer-guide/performance)
- [deck.gl: animations and transitions](https://deck.gl/docs/developer-guide/animations-and-transitions)
- [deck.gl: views](https://deck.gl/docs/developer-guide/views)
- [Cesium ion access-token documentation](https://cesium.com/downloads/cesiumjs/releases/1.111/Build/Documentation/Ion.html)

**Basemaps, data, imagery**
- [OpenFreeMap home](https://openfreemap.org/)
- [OpenFreeMap Terms of Service](https://openfreemap.org/tos/) (updated 14 Oct 2026)
- [OpenMapTiles building layer definition](https://github.com/openmaptiles/openmaptiles/blob/master/layers/building/building.yaml)
- [Protomaps basemap downloads](https://docs.protomaps.com/basemaps/downloads)
- [Protomaps Buildings.java](https://github.com/protomaps/basemaps/blob/main/tiles/src/main/java/com/protomaps/basemap/layers/Buildings.java)
- [Protomaps basemaps-assets (fonts, sprites)](https://github.com/protomaps/basemaps-assets)
- [OSMF attribution guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)
- [USGS: terms of use for The National Map](https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map)
- [Ohio OSIP cached imagery service](https://maps.ohio.gov/image/rest/services/osip_most_current_cache/MapServer) and [portal item](https://maps.ohio.gov/portal/sharing/rest/content/items/5b79a50c630348fbb89cfc23573e178c) (updated 16 Jun 2026)
- [OSIP product metadata example (public-domain statement)](https://gis1.oit.ohio.gov/ZIPARCHIVES/ELEVATION/GRIDTILES/OSIP_AUG_RASTER_DEM/RASTER/N1425315.xml)

**Symbology**
- [ANSI INCITS 415-2006 (R2022)](https://webstore.ansi.org/standards/incits/incits4152006r2022)
- [FGDC HSWG symbology FAQ](https://www.fgdc.gov/hswg/ref_pages/SymbolFAQ_ref.htm) and [background](https://www.fgdc.gov/HSWG/ref_pages/SymbologyBackground_ref.htm)
- [NAPSG Foundation symbology (CC BY 4.0)](https://www.napsgfoundation.org/symbology)
- [NAPSG DHS-Symbol-Server repository](https://github.com/NAPSG/DHS-Symbol-Server)
- [FEMA IPAWS symbology tip (Apr 2021)](https://www.fema.gov/sites/default/files/documents/fema_tip-36-symbology.pdf)
- [USCG ICS map display symbology](https://filelib.wildlife.ca.gov/Public/OSPR/rimai/2014_EROS/EROS_CD/FederalGovernment/USCG/ICS/ToolsSupplies/ICS%20Map%20Display%20Symbology.pdf)
- [map.army general options (civil/police symbols)](https://www.map.army/doc/en/options/general/)

**HMI, alarms, situation awareness**
- [ISA-101 standards page](https://www.isa.org/standards-and-publications/isa-standards/isa-101-standards)
- [Hollifield, *The High Performance HMI* (PAS, 2012, hosted by ISA)](https://www.isa.org/getmedia/06130a38-f7af-4b35-8c9c-2c34f25c1977/The-High-Performance-HMI-Overview-v2-01.pdf)
- [ANSI/ISA-18.2-2016](https://webstore.ansi.org/standards/isa/ansiisa182016)
- [Siemens white paper on ISA-18.2](https://cache.industry.siemens.com/dl/files/836/109772836/att_1002094/v1/WP_Alarm_Management_ISA_18.pdf)
- [EEMUA 191, 4th edition contents (Nov 2024)](https://www.eemua.org/getattachment/9d3f8071-55c3-49bf-a74a-3bf6ad4a2e0f/Contents-EEMUA-Publication-191-Edition4-November-2024.pdf)
- [HSE CHIS6, *Better alarm handling*](https://www.hse.gov.uk/pubns/chis6.pdf)
- [Endsley 1995, *Human Factors* 37(1)](https://doi.org/10.1518/001872095779049543)
- [Endsley, *Designing for Situation Awareness*, 2nd ed. 2012](https://doi.org/10.1201/b11371)
- [Joint Commission Sentinel Event Alert 50 (2013)](https://www.jointcommission.org/resources/sentinel-event/sentinel-event-alert-newsletters/sentinel-event-alert-issue-50-medical-device-alarm-safety-in-hospitals/)

**Operations-tool patterns and comparison**
- [Esri: what is a dashboard](https://doc.arcgis.com/en/dashboards/latest/get-started/what-is-a-dashboard.htm)
- [Esri Experience Builder Swipe widget](https://doc.arcgis.com/en/experience-builder/latest/configure-widgets/swipe-widget.htm)
- [FAA JO 7210.3, ch. 3 §9 (colour displays)](https://www.faa.gov/air_traffic/publications/atpubs/foa_html/chap3_section_9.html)
- [SGSA SG03 Annex C: control points](https://sgsa.org.uk/wp-content/uploads/2021/09/Annex-C-Control-points.pdf)
- [Gleicher et al. 2011, *Visual comparison for information visualization*](https://doi.org/10.1177/1473871611416549)

**Colour, uncertainty, crowd levels**
- [NEI: colour blindness](https://www.nei.nih.gov/learn-about-eye-health/eye-conditions-and-diseases/color-blindness) (updated Nov 2025)
- [Crameri, Shephard & Heron 2020, *Nature Communications*](https://doi.org/10.1038/s41467-020-19160-7)
- [Nuñez, Anderton & Renslow 2018, *PLOS ONE* (cividis)](https://doi.org/10.1371/journal.pone.0199239)
- [Fruin 1971, *Highway Research Record* 355](https://onlinepubs.trb.org/Onlinepubs/hrr/1971/355/355-001.pdf)
- [MacEachren et al. 2012, IEEE TVCG](https://doi.org/10.1109/TVCG.2012.279)
- [Kinkeldey, MacEachren & Schiewe 2014, *Cartographic Journal*](https://doi.org/10.1179/1743277414Y.0000000099)

**Field use and accessibility**
- [WCAG 2.2 (W3C Recommendation, 12 Dec 2024 version)](https://www.w3.org/TR/WCAG22/)
- [W3C: what's new in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/)
- [Parhi, Karlson & Bederson 2006, MobileHCI](https://www.microsoft.com/en-us/research/wp-content/uploads/2006/01/parhi-mobileHCI06.pdf)
- [Touch zone sizing for mobile devices in military applications (HCII 2016)](https://link.springer.com/chapter/10.1007/978-3-319-40406-6_7)
- [Hoober 2013, *How do users really hold mobile devices?*](https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php)
- [MDN: storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [DOJ Title II final rule, *Federal Register*, 24 Apr 2024](https://www.federalregister.gov/documents/2024/04/24/2024-07758/nondiscrimination-on-the-basis-of-disability-accessibility-of-web-information-and-services-of-state-and-local-government-entities)
- [ADA.gov fact sheet (updated for the 2026 IFR)](https://www.ada.gov/resources/2024-03-08-web-rule/)
- [DOJ interim final rule extending compliance dates (20 Apr 2026)](https://www.ada.gov/assets/pdfs/2026-ifr.pdf)

**Repository files**
- [`world/src/osm/raster.ts`](../../world/src/osm/raster.ts) (projection)
- [`01-domain-practice.md`](01-domain-practice.md) §1.4 (Fruin table)

Content was rephrased for compliance with licensing restrictions.
