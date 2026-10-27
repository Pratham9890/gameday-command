# 02 — Engine research: models, calibration, V&V, vehicles, screening, Rust→WASM (v3)

*Research note for Gameday Command v3, October 2026. It draws on papers and standards cached in `.scratch/research/` and a few pages fetched that month. Every figure has a source. "Derived" marks my arithmetic on sourced figures; "assumption" marks a value nobody has measured for us; "measured" marks the throwaway benchmark in §7. "Today" means the TypeScript engine in `engine/src/` as logged in `CLAUDE.md`.*

**Summary.** Keep today's tactical layer: one Dial's-algorithm distance field per destination. Replace the 2 m-cell dot crowd with **one agent per person** moved by the **collision-free speed model (CSM)** of Tordeux, Chraibi and Seyfried, on a **fixed 0.2 s tick**. Move cars onto an **OSM lane graph with IDM + MOBIL**. Make gates **multi-lane servers** with sampled service times. Build it as one Rust `wasm32-unknown-unknown` module with structure-of-arrays (SoA) state, a counting-sort spatial hash and strict determinism rules. Run one worker per plan in the browser, and the same `.wasm` under Node `worker_threads` for ensembles and V&V. Measured on this sandbox: **10–23 ms per step for 100k agents** at 0.5–2 p/m² in single-threaded wasm, **bit-identical** native vs wasm vs 1/3/8 concurrent workers.

## 1. Pedestrian models compared

| Model | Rule | Realism evidence | High density | Cost, usual Δt | Determinism | Implementation (licence) |
| --- | --- | --- | --- | --- | --- | --- |
| **Social force** ([Helbing & Molnár 1995](https://arxiv.org/abs/cond-mat/9805244); [Helbing et al. 2000](https://arxiv.org/abs/cond-mat/0009448)) | 2nd-order ODE: relax to desired velocity (τ 0.5 s) plus exponential repulsion (A 2000 N, B 0.08 m) and contact forces (k 1.2·10⁵ kg/s², κ 2.4·10⁵ kg/(m·s)) | Lanes, door oscillation, faster-is-slower. Fastest corner in the [RiMEA comparison](https://www.sne-journal.org/fileadmin/user_upload_sne/SNE_Issues_OA/SNE_25_1/articles/sne.25.1.10279.tn.OA.pdf) (test 6: 19.1 s) | Overlap and oscillation trade off against each other ([GCFM §III](https://arxiv.org/abs/1008.4297)) | Neighbour sum plus integrator; ~0.01 s | Stiff forces amplify float noise | JuPedSim (LGPL-3.0) |
| **GCFM** ([Chraibi et al. 2010](https://arxiv.org/abs/1008.4297)) | Force model with speed-dependent ellipses: a = 0.18 m + 0.53 s·v, b 0.20–0.25 m; repulsion ∝ (η·v0 + v_rel)²/dist | Fitted to single-file and 2D fundamental diagrams | Better than social force; η still trades overlap against oscillation | Ellipse distances plus 3 points per wall; 0.01 s Euler | Medium | JuPedSim (LGPL-3.0) |
| **Optimal Steps (OSM)** ([Seitz & Köster 2012](https://link.aps.org/doi/10.1103/PhysRevE.86.046108)) | Footsteps in continuous space; each step picks the point on a circle that minimises target + pedestrian + obstacle potentials. Vadere: step length 0.4625 + 0.2345·v m | Natural stepping; widely validated | Stable | Highest: an optimisation per step (Nelder–Mead default); event-driven | Event order must be total | [Vadere](https://github.com/pedestrian-dynamics-HM/vadere) (LGPL-3.0) |
| **ORCA / RVO2** ([UNC](https://gamma.cs.unc.edu/ORCA/)) | A 2D linear program per agent picks the nearest collision-free velocity over a horizon τ | Robotics origin. RiMEA test 12: 394.7 s against 185.0 s (social force) and 161.1 s (CA), with turbulence at bottlenecks and the fundamental-diagram peak at too high a density (Seer & Matyus 2015) | LP infeasibility leads to freezing | "Thousands of agents in a few ms" (UNC); 0.1–0.25 s | Sensitive to constraint order | [RVO2](https://github.com/snape/RVO2) (Apache-2.0) |
| **CSM** ([Tordeux et al. 2015](https://arxiv.org/abs/1512.05597)) | 1st order: ẋ = V(s)·e, V(s) = min(v0, max(0, (s−ℓ)/T)), e = N(e0 + Σ a·exp((ℓ−s_ij)/D)·e_ij) | Lanes up to 6 p/m², flow linear in bottleneck width, intermittent counter-flow. **No stop-and-go waves** (authors' caveat) | **Collision-free by construction** | One neighbour pass, no velocity state; paper uses 0.01 s, §1.1 shows 0.2 s is fine | Low | JuPedSim (LGPL-3.0); about 5 lines to reimplement |
| **Floor-field CA** ([Burstedde et al. 2001](https://arxiv.org/abs/cond-mat/0102397)) | 40×40 cm cells; hops weighted by static and dynamic floor fields | Lanes and clogging, but speed is quantised (≈0.3 s per cell). RiMEA comparison: scattered local fundamental diagram, slowest corner (50.6 s) | Stable | Cheapest; 0.3 s | Low | Trivial |
| **Continuum** ([Hughes 2002](https://www.researchgate.net/publication/222556037_A_continuum_theory_for_the_flow_of_pedestrians); [Treuille et al. 2006](http://www.ccs.neu.edu/home/scooper/index_files/pub/treuille2006continuum.pdf)) | Density PDE plus an eikonal potential | Good mass flow; no individuals | Stable | O(cells), independent of N | Low | — |

**What fits Gameday.**

- **Individuals are mandatory.** Per-person decisions, the person detail panel and the per-dot tape (`CLAUDE.md`) rule out continuum as the main model. It remains useful as a far-field level of detail and a mass-balance check.
- **Force models fail the budget.** They need Δt ≈ 0.01 s and still overlap. OSM's per-step optimisation is the costliest option.
- **CSM** is collision-free, has 5 parameters and no inertia, so it tolerates a large Δt.
- **What CSM lacks: stop-and-go and turbulence.** These are the precursors in [Helbing et al. 2007](https://arxiv.org/abs/physics/0701203), so the UI must not imply they are predicted. The documented upgrade is JuPedSim's anticipation velocity model (defaults T 1.06 s, anticipation 1.0 s, reaction 0.3 s; [default tests](https://github.com/PedestrianDynamics/jupedsim/blob/master/python_modules/jupedsim/tests/test_model_defaults.py)).

### 1.1 Recommendation: distance field (tactical) + CSM (operational)

Per agent *i* (radius r_i, desired speed v0_i, desired direction e0_i = −∇φ from the field, bilinear):

1. **Front spacing.** Over neighbours *j* within R_c with e_i·(x_j−x_i) ≥ 0 and lateral offset |e_i^⊥·(x_j−x_i)| ≤ ℓ_ij = r_i + r_j: s_i = min(‖x_j−x_i‖ − ℓ_ij), otherwise ∞. This follows the JuPedSim `get_spacing` convention.
2. **Speed.** V_i = min(v0_i, max(0, s_i/T)).
3. **Direction.** e_i = N(e0_i − Σ_j a_n·exp((ℓ_ij−d_ij)/D_n)·û_ij + Σ_walls a_w·exp((r_i−d_iw)/D_w)·n̂_iw).
4. **Move.** x_i += Δt·V_i·e_i, as a parallel (Jacobi) update: everyone reads the previous positions.

| Parameter | JuPedSim default ([source](https://github.com/PedestrianDynamics/jupedsim/blob/master/libsimulator/src/operational_models/collision_free_speed_model/collision_free_speed_model.hpp)) | Paper | **v3 start value** |
| --- | --- | --- | --- |
| T | 1.0 s | 1 s | 1.0 s |
| r (ℓ = 2r) | 0.2 m | ℓ 0.3 m | **0.15 m**: JuPedSim's 0.2 m ran 30–40% below Weidmann (§7, measured) |
| v0 | 1.2 m/s | 1.2 m/s | Fan type × N(1.34, 0.26), clipped [0.5, 2.2] (§2.1) |
| a_n, D_n | 8, 0.1 m | 5, 0.1 m | 8, 0.1 m |
| a_w, D_w | 5, 0.02 m | — | 5, 0.02 m |
| R_c | 3 m | — | 1.5–2 m (speed saturates once s ≥ v0·T; repulsion at a 1 m gap is 8·e⁻¹⁰ ≈ 4·10⁻⁴; derived) |

**Time step.** Each step closes at most Δt/T of the front gap, and two agents walking head-on close at most 2Δt/T of it. Any Δt < T/2 therefore cannot overrun the gap (derived). At Δt = 0.2 s a free walker moves 0.27 m per step, less than one 0.5 m collision cell. The measured mean speeds at 0.1 s and 0.2 s differed by ≤4% (§7). **Use Δt = 0.2 s.** Decisions, density and scoring stay on 1 s ticks.

## 2. Calibration data

**Speeds.**

| Item | Value | Source |
| --- | --- | --- |
| Free speed on the flat | 1.34 m/s (Weidmann); men 1.41, women 1.27 | [RiMEA 4.1.1](https://rimea.de/downloads/) Tab. 1, §3.2.2 |
| Impaired mobility | 0.46–0.76 m/s | RiMEA Tab. 2 |
| Spread | N(1.34, 0.26), clipped 0.5–2.2 m/s | [Vadere](https://github.com/pedestrian-dynamics-HM/vadere) agent defaults; Helbing & Molnár 1995 |
| Commercial-tool default | U(0.65, 2.05) m/s, body radius 0.25 m | [MassMotion V&V 2024](https://www.oasys-software.com/wp-content/uploads/2024/07/Fire-Evacuation-VV.pdf) Tab. 5 (after Fruin) |
| Stairs (fraction of flat speed) | Up 42.5% (≤27°) to 37.8% (>32°); down 57.4% to 49.8% | MassMotion defaults (after Fruin) |
| Stairs by age (Fruin) | Down 0.76 / 0.65 / 0.55 m/s and up 0.55 / 0.50 / 0.42 m/s for <30 / 30–50 / >50 years (indoor) | RiMEA Tab. 3 |

**Fundamental diagram.**

- Weidmann: v = v0·[1 − exp(−γ(1/ρ − 1/ρ_max))], with v0 1.34 m/s, γ 1.913 m⁻², ρ_max 5.4 m⁻². This is already in `movement-flow.ts`. The normalised form with 0.35 is [Johansson et al. 2008](https://arxiv.org/abs/0810.4590) eq. 14 (0.35 × 5.4 ≈ 1.89; derived).
- Peak specific flow: 1.22 p/(m·s) at 1.75 p/m² (Weidmann), 1.25 (Fruin), 1.32 (SFPE) (RiMEA Tab. 1).
- Single file: d = 0.36 + 1.06·v m ([Seyfried et al. 2005](https://arxiv.org/abs/physics/0506170)). CSM gives ℓ + T·v, which matches in slope when T = 1 s (derived).
- In v3 the diagram **emerges** from CSM and is a test target. Today's imposed `SPEED_BY_COUNT` lookup is retired.

**Bottlenecks.**

- Flow is linear in width: J ≈ 1.9·b (1/s) for b = 0.8–1.2 m, with specific flow 1.61–2.31 p/(m·s) ([Seyfried et al.](https://arxiv.org/abs/physics/0702004) Tab. 2, Fig. 9).
- Handbook capacities disagree with each other by up to about 100%.
- Initial density dominates. In Nagai's data, flow at b = 1.2 m rises from 1.04 to 3.31 1/s as the initial density goes from 0.4 to 5 m⁻².
- V&V door cap: ≤1.33 p/s through 1 m (IMO test 4). Fruin's peak is 82 p/m/min ≈ 1.37 p/(m·s) (MassMotion V&V §6).

**Groups.** Up to 70% of people walk in groups: 55% at 0.03 p/m², 70% at 0.25 p/m². Speed falls linearly with group size; the model fit is v ≈ 1.3 − 0.05·n (low density). Groups walk abreast at low density and in a V shape as it rises ([Moussaïd et al. 2010](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0010047), CC BY). In v3, group members share a decision key and target, and a centroid cohesion term enters the CSM direction sum. The group's v0 is its members' minimum (assumption).

**Crowd pressure.**

- [Helbing et al. 2007](https://arxiv.org/abs/physics/0701203) define pressure as P = ρ·Var(V).
  - At Jamarat, turbulence began at **P > 0.02 s⁻²**.
  - Above **6 p/m²** local flow fell by **≥3×**.
  - Local peaks were about **twice** the average density (R = 1 m).
  - Stop-and-go began once flow fell below **0.8 p/(m·s)**.
- Average density rarely exceeds 6 p/m², and pressure beats density or velocity alone as a warning sign ([Johansson et al. 2008](https://arxiv.org/abs/0810.4590)).
- **v3** computes R = 1 m Gaussian density, pressure and Fruin LoS ([Fruin 1971](https://onlinepubs.trb.org/Onlinepubs/hrr/1971/355/355-001.pdf); metric table in [01-domain-practice](01-domain-practice.md) §1.4) per zone per second. These are labelled *model indicators*: CSM has no momentum, so pressure is a proxy.

**Open datasets for regression fixtures.** All are from the [Jülich Pedestrian Dynamics Data Archive](https://ped.fz-juelich.de/da/doku.php), **CC BY 4.0** (badge on each page, checked October 2026), as 16/25 fps trajectories (txt/HDF5).

| Fixture | DOI (10.34735/…) | Test |
| --- | --- | --- |
| Single file, Caserne | ped.2006.1 | 1D FD (RiMEA 16) |
| Bottlenecks, Caserne / Rotunde | ped.2006.2, ped.2005.2 | J(b) (RiMEA 12d) |
| Corridor uni / bi (BaSiGo 2013) | ped.2013.6 / ped.2013.5 | 2D FD (RiMEA 4); counter-flow (IMO 8) |
| Crossings 90°/120°, T-junction, corner | ped.2013.4, .2013.3, .2009.7, .2009.8–9 | Merging, corners |
| Entrance semicircle / corridor; crowds before bottlenecks | ped.2013.2 / .2013.1; ped.2018.1 | **Gate approach**: queue shape and density against width (validation only) |
| Stadium stairs and mouth holes (Esprit Arena 2009) | ped.2009.1–5 | Stadium egress |
| Social groups; wheelchair/luggage | ped.2013.8, ped.2014.1; ped.2022.3 | Verif.2.9, 2.10 |

Commit only **derived curves** (binned v(ρ) p10/p50/p90, J(b)) with a `DATA-LICENCE.md`. A script fetches the raw data. The RiMEA test-16 10/90% band is downloadable, but its licence is unstated: check before vendoring.

## 3. V&V suites as automated tests

- **RiMEA 4.1.1** (11 Sep 2025): tests 1–16, with 12a–d.
- **IMO MSC.1/Circ.1533** (6 Jun 2016, [Annex 2](https://www.deutsche-flagge.de/de/redaktion/dokumente/interpretationen/solas/ii-2/msc-1-circ-1533-revised-guidelines-on-evacuation-analysis-for-new-and-existing-passenger-ships.pdf)): tests 1–12 plus a convergence criterion.
- **NIST TN 1822** ([Nov 2013](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.1822.pdf)): 18 Verif.* tests over 5 core components.

Arup runs IMO and NIST as an automated suite ([MassMotion 11.8](https://www.oasys-software.com/wp-content/uploads/2024/07/Fire-Evacuation-VV.pdf)). Gameday's crate `gd-vv` builds each geometry as a small map and asserts natively under `cargo test`. The same scenarios run through the `.wasm` in Vitest for parity, and results go as JSON to an auto-generated V&V report.

| Suite IDs | Scenario | Pass criterion (source) | Gameday test |
| --- | --- | --- | --- |
| RiMEA 1, IMO 1, NIST 2.1 | 1 person, 2×40 m corridor | 26–34 s at 1.33 m/s (RiMEA); 40 s at 1 m/s (IMO) | `corridor_speed`: time = L/v0 ± 1 tick, at **0° and 45°** rotation and field cells 0.5 / 1 m (NIST asks for both) |
| RiMEA 2–3, IMO 2–3, NIST 2.2 | 1 person, 10 m stair up/down | 10 s at 1 m/s (IMO) | `stair_speed` with Fruin factors; down faster than up |
| RiMEA 4, IMO 12 | 1000×10 m corridor at 0.5–6 p/m²; 2×2 m areas over 60 s; single-file variant | Produce the FD; flow lower at very high density | `fd_2d`: inside the band from the Jülich corridor for ρ ≤ 4; J(6) < J(2); periodic domain |
| RiMEA 5, IMO 5, NIST 1.1 | 10 people, pre-movement U(10, 100) s | Each starts on time | `premovement`, plus a KS test over 1,000 seeds |
| RiMEA 6, IMO 6, NIST 2.3 | 20 people round a corner | No wall crossed | `corner_no_penetration` invariant |
| RiMEA 7, IMO 7, NIST 2.4 | 50 sampled people | Speeds match the table | `demographics` (KS) |
| RiMEA 8 | Parameter study | Document only | `param_sweep`, nightly |
| RiMEA 9, IMO 9 | 1,000 people, 4 exits, then 2 closed | About double the time (RiMEA: documentation only) | `four_exits_halved`: ratio 1.6–2.4 (assumption) |
| RiMEA 10, IMO 10, NIST 3.1 | 23 people with assigned exits | All use their assigned exit | `exit_allocation` |
| RiMEA 11 | 1,000 people, 2 exits | Mostly the near exit, some the far one | `route_choice`: 0 < far share < 50% |
| RiMEA 12a–c | 150 agents: goal distance, bottleneck length, two bottlenecks in series | Time rises then flattens with distance; long bottleneck slower; congestion only at the first bottleneck | `goal_distance`, `bottleneck_length`, `serial_bottlenecks` |
| RiMEA 12d, IMO 4, NIST 5.2 | Widths 0.8–1.2 m; 100 people at a 1 m door | J rises with b; ≤1.33 p/s per 1 m | `bottleneck_width`: J ≈ 1.9·b ± 25%; `door_cap` |
| RiMEA 13–15 | Stair FD; route via another floor; 500 people round a corner | down > up; document choice; corner time between straight times | `stair_fd` (exterior stairs only), `route_doc` ("configurable"), `corner_bounds` |
| RiMEA 16 | 1D ring | Inside the 10/90% band | `fd_1d` against Jülich ped.2006.1 |
| IMO 8, NIST 2.8 | Counter-flow of 10/50/100 people | Time rises with counter-flow | `counterflow_monotone` |
| IMO 11, NIST 5.1 | Room, corridor, stair at 2.5 p/m² | Queues at room exit and stair base | `congestion_locations` |
| NIST 2.9 / 2.10 | 5-person group passing slow people; mobility mix | Group arrives within 10 s | `group_cohesion`; `mobility_mix` |
| NIST 4.1 | Exit closes after 1 s | Not used | `dynamic_closure`: no one crosses a closed closable |
| NIST 2.5–2.7, 3.2–3.3 | Smoke, incapacitation, elevators, social influence | — | Documented as not modelled, or covered by decision tests |

**Gameday invariants** (from `CLAUDE.md`):

- `determinism`: equal state hash per checkpoint, native vs wasm, Chrome vs Node.
- `rewind_equivalence`.
- `traffic_isolation`: cars depend on people, never the reverse.
- `no_unscreened_entry`.
- `shell_doorways`.
- `gate_service_rate`: a saturated gate passes c/E[S] ± 3%.
- `mass_balance`.

**Statistics.**

- IMO App. 3: ≥50 runs (≥10 populations × 5), judged on the 95th centile, with a convergence check every 50 runs.
- RiMEA §2.16: min, max, mean, SD and a significant (95%) time.
- NIST §4.1: five convergence measures (total time, SD, Euclidean relative difference, Euclidean projection coefficient, secant cosine) over *b* consecutive runs.
- NIST §3.2: do not validate on calibration data. So calibrate on the corridor and bottleneck sets and validate on the entrance and crowdqueue sets.

## 4. Vehicles

Today's traffic is cell-based: 2 m footprints, BFS fields and a 25 s squeeze rule (`traffic.ts`). v3 moves to a **lane graph** with continuous positions along each lane.

**IDM** ([Treiber et al. 2000](https://arxiv.org/abs/cond-mat/0002177)): a = a_max·[1 − (v/v0)^δ − (s*/s)²], with s* = s0 + v·T + v·Δv/(2√(a_max·b)).

| Set | v0 | T | a_max | b | s0 | δ | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Freeway | 120 km/h | 1.6 s | 0.73 | 1.67 m/s² | 2 m | 4 | IDM Tab. I |
| Multi-lane | 80/120 km/h ±20% | 1.2 s | 1.5 | 2.0 | 2 m | 4 | [MOBIL paper](https://mtreiber.de/publications/MOBIL_TRB.pdf) §3 |
| **Gameday urban** | OSM `maxspeed`, else 25/35 mph (residential/arterial) | 1.2 s | 1.5 | 2.0 | 2 m | 4 | T, a, b from MOBIL; speeds are placeholders (assumption) |

- **Update.** Use the ballistic update, which always beats Euler ([Treiber & Kanagaraj 2015](https://arxiv.org/abs/1403.4881)). The MOBIL authors saw marginal differences between 0.25, 0.1 and 0.01 s. **Use Δt = 0.2 s**, sharing the people tick.
- **MOBIL.** Incentive: ã_c − a_c + p·[(ã_n − a_n) + (ã_o − a_o)] > Δa_th (± Δa_bias). Safety: ã_n ≥ −b_safe. Use p ∈ [0, 1] (Gameday 0.2, assumption), Δa_th 0.1 m/s², b_safe 4 m/s², Δa_bias 0.3 m/s² (paper Tab. 1). Mandatory changes use a virtual stopped vehicle with p = 0. MOBIL applies only to streets with ≥2 lanes per direction.
- **Lane graph from OSM.**
  - Edges: one per lane per segment, from `lanes`, `lanes:forward/backward`, `oneway`, `junction=roundabout`, `turn:lanes` and `maxspeed`. `service=parking_aisle` gives 4.5 m/s two-way lot edges (today's `LOT_SPEED_MPS`). Stalls come from today's 2.7 m pitch, 5.5 m depth and 6 m aisle (assumptions).
  - Nodes: connector lanes plus a controller (signal, stop, give_way, priority, or officer).
  - **Gap:** `KEEP_TAGS` in [`world/src/osm/fetch.ts`](../../world/src/osm/fetch.ts) drops these tags, and the query is `out geom` with ways only. In the committed extract only **166 of 2,933** highway ways carry `lanes`; **none** carry `oneway` or `maxspeed`; there are **0 tagged nodes** (no signals, crossings or stops); there are 230 parking aisles (counted).
- **Control.**
  - Signals: fixed 90 s two-phase cycle (assumption; OSM has no timing). Red is a virtual stopped leader at the stop line.
  - **Officer traffic control points:** when the officer arrives (they walk), the node switches to officer mode and releases one approach at a time by plan priority (min 20 s, max 120 s, assumption). Phase decisions go on the tape.
  - **Closures** are escape-only, and EMS waits for an open approach (carried over).
  - **Contraflow** reverses lanes after a flush (lanes empty, plus 10 min set-up; assumption). The UI shows the flush as a cost.
- **Pedestrian yielding.** People inside a lane's swept corridor are stopped leaders, and crosswalks give pedestrians priority. Today's crowd rule carries over: crawl above 0.5 p/m², stop above 2.5 p/m² (EMS 3.5).
- **Routing.** By travel time; edge times refresh every 60 s in fixed edge order. Leader lookup uses per-lane sorted arrays.
- **Cost.** About 30 flops per vehicle per step: 0.75 Mflop per sim second for 5,000 vehicles (derived).

## 5. Gates & screening

**Ohio Stadium.** No bags (wallets up to 5×8×1 in.) and a metal detector for every guest. Medical and childcare bags use two named doors. No re-entry. Gates open 2 h before kickoff ([OSU A–Z](https://ohiostatebuckeyes.com/sports/2022/4/11/az-guide), via [01-domain-practice](01-domain-practice.md)). So each lane runs **ticket scan → walk-through metal detector (WTMD) → hand-held wand on alarm**, with no bag search.

| Stage | Figure | Source |
| --- | --- | --- |
| WTMD at a venue | 9 s per patron: 6.67/min, **400/h per lane** | [CISA Patron Screening (2016)](https://www.cisa.gov/sites/default/files/publications/patron-screening-guide-03-16-508.pdf) §6 |
| Hand-held wand | 16 s: 3.75/min, 225/h | same |
| WTMD standard | ≥3,000/h (large weapons) or 1,500/h (small) at 95% detection; the effective rate is lower (divestment, procedures); false alarms <15% acceptable | [DHS S&T market survey, Sep 2024](https://www.dhs.gov/sites/default/files/2024-09/24_0924_st_weaponsscreeningmsr_1.pdf) §2.2.3 (ASTM F3566-22) |
| Vendor maxima | 12–70/min (2014 WTMDs, most 40–60); 1,200–10,000/h (2024 systems) | [SAVER 2014](https://www.dhs.gov/sites/default/files/publications/WTMD-MSR_0614-508.pdf) Tab. 3-1; SAVER 2024 §4 |
| Sensitivity vs throughput | More sensitivity means more nuisance alarms and less throughput | [DHS TechNote 2024](https://www.dhs.gov/sites/default/files/2024-05/24_0522_st_weaponsscreeningtechnote.pdf); [CISA 2026](https://www.cisa.gov/sites/default/files/2026-08/FINAL_Public_Venue_Security_Screening_AUG2026_508.pdf) |
| UK design entry rate | 660/h per entry point | SGSA (via 01-domain-practice) |
| Ticket scan alone | No public measurement found | Assumption: 2–4 s |

**Scale check (derived).** 100,000 people in 2 h at 400 per lane-hour needs **125 lanes running nonstop**, and arrivals peak near kickoff. Lane counts per gate are therefore an editable, labelled assumption (matches DOM-05).

**Queue model.** This replaces `throughputPerMin`, `GATE_BURST_S` and the officer +10%.

- **Lanes.** Each gate has c_g(t) lanes. A lane is a physical service point plus a funnel on the outside arc of the corridor (carried over). An idle server cannot bank capacity.
- **Service time.** S = S_scan + S_wtmd + B·S_sec, with B ~ Bernoulli(p_alarm):
  - S_scan: log-normal, mean 3 s, CV 0.5.
  - S_wtmd: log-normal, mean 6 s, CV 0.4. Scan plus WTMD gives CISA's 9 s.
  - p_alarm = 0.10 (below DHS's 15% bound).
  - S_sec: log-normal, mean 16 s (CISA), on one wand server per two lanes.
  - The CVs, p_alarm, the scan/WTMD split and the wand ratio are assumptions. Draws come from a per-gate RNG stream in lane order.
- **Lane choice.** People choose a lane once, within queue reach, by expected wait (queue length + 1)/servers × E[S]. No jockeying unless the lane closes. This follows CISA's advice to steer people to short lines. The queue behind the funnel is physical: CSM sets its density, and the pressure indicator applies there.
- **Levers.**
  - Open or close lanes.
  - Change sensitivity: p_alarm and E[S_wtmd]. The tradeoff is shown, never advised.
  - Officers as extra wand servers.
  - Shut the gate: its queue is turned away (as today).
- **CI checks.**
  - A saturated gate passes c/E[S] ± 3%.
  - Under Poisson arrivals, the mean wait W_q matches the Allen–Cunneen M/G/c approximation [C(c, λ/μ)/(cμ−λ)]·(1 + C_s²)/2 within 10%.
- **Outputs per gate-minute:** arrivals, admissions, queue length, mean and p90 wait, open lanes, alarms.

## 6. Rust→WASM architecture

1. **SoA, split hot and cold.**
   - Mutable per person: `x, y: f32`, `state, flags, gate, lane: u8`, `timer: i32`, `field: u16`, `group: u32`. That is ≈24 B, **2.4 MB per 100k** (derived), and it is all a checkpoint copies.
   - Immutable after spawn: `v0, r, fan_type, lot, seat, arrive_at`.
   - Vehicles: `edge, s, v, lane, kind, mode, route`.
2. **Clock.** An integer `tick` with Δt = 0.2 s; time is computed as integer milliseconds. Per sim second, in `CLAUDE.md` order: hooks, orders, decisions (pause), officers, 5 × (people, vehicles, gates), density and pressure, scoring, then checkpoint or frame.
3. **Spatial hash.** A stable counting or LSD radix sort of person indices into 1.5 m cells, with cell-ordered copies of x, y, r. A neighbour row's three cells form one contiguous slice: **1.45–1.9× faster** than per-cell loops (measured). On the 1.6 km map the grid is 1.14 M cells (`cell_start` 4.6 MB; derived). Seated and off-map people are not inserted.
4. **Navigation fields.**
   - Port Dial's algorithm. Store u16 distances and sample the gradient; direction bytes zig-zag with CSM.
   - Per full-map field: 2 m = 1.28 MB, 1 m = 5.12 MB, 0.5 m = 20.5 MB (derived).
   - Plan: a 0.5 m u8 collision raster (10.2 MB); gate fields at 1 m, cropped to their catchment plus 100 m (assumption); lot and exit fields at 2 m in an LRU of 32 (≈41 MB).
   - Drop the cache on a closure change and rebuild on restore (carried over).
   - About 75 MB of fields per plan, ≈130 MB with checkpoints (derived).
5. **Level of detail.**
   - Seated people are records only; people off the map are timers.
   - People with no candidates in their three hash rows skip repulsion.
   - Rendering LOD stays in the app (viewport people plus a 2 m density grid).
   - No continuum fallback, since it would break the per-person tape.
6. **Deterministic floats.**
   - Core wasm float ops are deterministic except NaN bits ([Nondeterminism.md](https://github.com/WebAssembly/design/blob/main/Nondeterminism.md)).
   - **No FMA:** no `mul_add` and no relaxed SIMD, which gives up cross-architecture determinism ([Wasmtime](https://docs.wasmtime.dev/examples-deterministic-wasm-execution.html); [relaxed-simd](https://github.com/WebAssembly/relaxed-simd)).
   - **No platform libm:** use the pure-Rust `libm` crate (MIT/Apache-2.0) or tables. Native std calls the system libm.
   - **Ordered reductions**, with fixed chunks if threaded, and a **Jacobi update**.
   - **No HashMap iteration:** `RandomState` is randomly seeded per process ([std](https://doc.rust-lang.org/stable/std/collections/hash_map/struct.RandomState.html)). Ban it with clippy `disallowed_types`.
   - **Counter-based RNG streams** keyed by (seed, subsystem, entity, tick).
   - f32 for all state, which retires the `Math.fround` bug class.
   - An FNV state hash per checkpoint.
   - **Measured:** identical checksums native vs wasm, scalar vs `+simd128`, and 1/3/8 workers.
7. **SIMD128** is in Wasm 2.0 and deterministic. Autovectorisation gave **no gain** on this kernel (20.9 vs 20.4 ms, measured). Hand-written `f32x4` loops over the row slices are the next lever (unmeasured).
8. **Threads vs one worker per plan.**
   - Threads need SharedArrayBuffer, which needs a cross-origin isolated page (COOP `same-origin` + COEP `require-corp`/`credentialless`; [web.dev](https://web.dev/articles/coop-coep)). That also blocks non-CORS map tiles.
   - Rust wasm threads still need **nightly and a rebuilt std** (`+atomics,+bulk-memory,+mutable-globals`; [wasm-bindgen guide](https://rustwasm.github.io/docs/wasm-bindgen/examples/raytrace.html), [wasm-bindgen-rayon](https://github.com/RReverser/wasm-bindgen-rayon)).
   - Three single-threaded workers lost ≤9% each (measured).
   - **Use one worker per plan on stable Rust.** The Jacobi update keeps a threaded build possible later.
9. **Raw C-ABI exports, not wasm-bindgen.**
   - The benchmark used `#[unsafe(no_mangle)] extern "C"` plus a zero-copy `Float32Array` over `memory.buffer`. The module is 35 KB, with no glue, and is identical in browser and Node.
   - API: `init`, `step_until`, `pending_asks`, `answer`, `apply_order`, `frame_ptrs`, `checkpoint`, `restore`, `state_hash`.
   - Views detach when memory grows, so reserve memory at `init`. Copy frames out with `slice()` and transfer them.
10. **Checkpoint and restore.**
    - A versioned `GDCK` blob (engine, map and config hashes) holding the mutable arrays, RNG counters, lane queues and busy-until times, vehicles, officer bookkeeping, pending situations, scorer accumulators, and order and edit cursors. All of these are today's "a checkpoint is not just Snapshot" lessons.
    - ≈2.5 MB each (derived). Every 120 s over 90 min is ≈113 MB per plan, so use **240 s** (≈57 MB) plus 30 s checkpoints within ±10 min of the incident (assumption).
    - At 10–20× a seek re-simulates up to 24 s of wall time, so show progress.
11. **Decision tape.**
    - `step_until` returns `NeedsDecisions` with grouped asks (`buildAsks` by `decisionKey`). The host resolves them (cache, then Kev, then defaults) and calls `answer`.
    - The engine samples each person's choice from its stream.
    - Records go out **batched and columnar** per tick: ≈290k at 100k people for a lightning delay, derived from 57,974 per 20k dots.
12. **Ensembles.** The same `.wasm` runs under Node `worker_threads` for V&V (≥50 runs) and `docs/forecast.md`. **Measured:** checksums identical to the browser build.

**Crates** (`engine-rs/` workspace; the only planned dependency is `libm`):

| Crate | Owns |
| --- | --- |
| `gd-core` | Clock, RNG streams, SoA, state hash, lints |
| `gd-geo` | MapBundle import, raster, closables, OSM lane graph |
| `gd-nav` | Dial fields, cropped cache, gradient |
| `gd-ped` | CSM, hash, groups |
| `gd-gates` | Lanes and servers |
| `gd-traffic` | IDM, MOBIL, controllers, parking |
| `gd-officers` | Officers and TCPs |
| `gd-metrics` | Density, pressure, LoS, zone accumulators (the scorecard stays in `world/`) |
| `gd-sim` | Step order, orders, decisions, checkpoints, frames |
| `gd-wasm` | Exports |
| `gd-vv`, `gd-bench` | Tests and performance |

**Worker protocol.** `contracts.ts` `WorkerIn`/`WorkerOut` stay the outer contract. Per-person frames need a contract bump.

- **In:** `init{config, map, population, defaults, wasmUrl, replay?}`, `play`, `pause`, `speed`, `seek{t}`, `snapshot`, `order`, `edit`, and new `viewport{bbox, detail}`.
- **Out:** `ready`, `frame{t, people{x,y: u16 cm, state: u8} for the viewport, density f32 2 m, vehicles, officers}`, `scene`, `deciding`, `decisions{t, ids: Uint32Array, option: Uint8Array, source: Uint8Array}`, `tape`, `checkpointed`, `perf{stepMs, active}`, `done`, `error`.
- A full frame is ≈0.5 MB as u16 (derived).

## 7. Performance budget

**Target:** 100k agents + 5k vehicles at ≥10× real time per plan, three plans on an 8-core laptop. At Δt = 0.2 s that is **≤20 ms per step, all-in**.

**Published reference points.**

- Wasm is 45% (Firefox) to 55% (Chrome) slower than native on SPEC on average, peaking at 2.5× ([Jangda et al. 2019](https://www.usenix.org/conference/atc19/presentation/jangda)).
- ORCA handles thousands of agents in a few ms ([UNC](https://gamma.cs.unc.edu/ORCA/)).
- Today's engine runs 20k dots on a 1 s step at ~193× (brief) to 222–254× (`CLAUDE.md`). v3 does roughly 5× the agents × 5 steps plus neighbour work per sim second.

**Measured.** `/projects/sandbox/.scratch/engine-bench/`: Rust 1.92 → wasm32, opt 3 + LTO, Node 22.23, single thread, Xeon Platinum 8488C, 8 vCPU on a shared host (noise ≈ ±30%). 100,000 agents, CSM + counting-sort hash, Δt 0.1 s, uniform density on a periodic square, ms per step:

| Configuration | 0.5 p/m² | 1 | 2 | 4 |
| --- | --- | --- | --- | --- |
| r 0.2, 2 m cells, per-cell loops (wasm) | 38.9 | 41.9 | 79.4 | 166.1 |
| r 0.2, 2 m cells, row slices (wasm) | 20.4 | 29.0 | 54.3 | 112.3 |
| same, `+simd128` | 20.9 | 28.3 | 55.5 | 113.2 |
| r 0.15, 2 m cells, row slices (wasm) | 13.6 | 19.4 | 35.4 | — |
| **r 0.15, 1.5 m cells, row slices (wasm)** | **10.4** | **13.7** | **23.1** | — |
| r 0.2, 2 m, row slices (native, 2 runs) | 11.2–15.8 | 14.6 | 27.3–41.9 | 76.8 |

- Hash build: 0.6–1.1 ms. Neighbours within 2 m per agent: 5.9 / 8.6 / 21.9 / 46.9. Linear memory: 6.3–6.8 MB.
- **Concurrency** (ρ 2, r 0.2): 1 worker 57.9 ms; 3 workers 58.5 / 63.2 / 61.0 ms; 8 workers 58–87 ms. Checksum `3abdc143` everywhere, the same as native.
- **Fundamental-diagram sanity check** (2,000 agents, one direction, random start, mean speed over 60–120 s, at 0.5 / 1 / 2 / 3 p/m²):
  - r 0.2: 0.89 / 0.82 / 0.37 / 0.22 m/s.
  - **r 0.15: 0.98 / 0.97 / 0.62 / 0.36.**
  - Weidmann: 1.30 / 1.06 / 0.61 / 0.33 (derived).
  - Δt 0.2 vs 0.1 s: ≤4% apart.
  - The low-density shortfall comes from fast walkers platooning behind slow ones, which calibration must fix.

**Budget per step** (Δt 0.2 s, 10×):

| Item | Budget | Basis |
| --- | --- | --- |
| People (CSM + hash, 100k walking) | ≤14 ms | Measured 10.4–13.7 at ≤1 p/m²; 23.1 if all 100k stand at 2 p/m² |
| Vehicles (5k IDM/MOBIL) | ≤0.5 ms | Derived |
| Gates (~125 lanes) | ≤0.2 ms | Derived |
| Per-second work spread over 5 steps | ≤3 ms | Assumption, to be measured |
| Headroom | ~2 ms | — |

**Verdict.**

- **Met single-threaded** while the walking crowd averages ≤1 p/m²: 14.6× for the kernel alone, about 10× all-in (derived).
- **Not met** if all 100k stand at 2 p/m² (kernel only 8.7×). Seated and off-map people are excluded, so actual load is lower; peak concurrent walkers ≈ 50k at egress is an assumption to verify.
- Levers, in order: hand SIMD, then a front-half-disc scan for the spacing, then a threaded build.
- Three plans on 8 cores: fine (≤9% slowdown measured).
- Perf CI (`gd-bench` plus headless Chromium via playwright-core) fails on a >15% regression.

## 8. Recommended engine design (v3)

| Aspect | Decision |
| --- | --- |
| People | One agent per person. Dial u16 fields (1 m at gates, 2 m elsewhere). CSM with T 1 s, r 0.15 m, a_n 8, D_n 0.1 m, a_w 5, D_w 0.02 m, R_c 1.5–2 m, v0 = fan type × N(1.34, 0.26) clipped [0.5, 2.2]. Group cohesion. CI calibration against Weidmann and Jülich |
| Vehicles | OSM lane graph. IDM (1.2 s, 1.5, 2.0, 2 m, δ 4), ballistic update. MOBIL (p 0.2, 0.1, 4). Signal, stop, yield and officer TCP controllers. Escape-only closures. Contraflow with a flush. People as obstacles |
| Gates | Lanes: scan → WTMD → wand; log-normal service (9 s mean), p_alarm 0.10; editable lane counts |
| Clock | Integer ticks of 0.2 s. Decisions, density and scoring at 1 s. Frames at 15 s plus a viewport feed |
| Data | SoA (hot/cold), f32, 1.5 m radix-sorted hash |
| Determinism | No FMA, relaxed SIMD, platform libm or HashMap iteration. Ordered reductions, Jacobi update, counter RNG, state hash per checkpoint. CI compares native, Chrome and Node |
| Packaging | One C-ABI `.wasm`. One worker per plan; Node `worker_threads` for ensembles |
| Tests and budget | §3 suite and invariants; ≤20 ms per step all-in |

**Migration.**

1. Record tolerance-based behavioural targets from the TS engine: clearance A/B/C, admissions at kickoff +30, gate stats.
2. `gd-core`, `gd-geo`, `gd-nav` and a wasm host in `worker.ts`. The Dial port must reproduce today's integer distances exactly.
3. `gd-ped`, V&V and calibration, plus the Jülich fixtures.
4. Gates, seating, exits, game-end and the late rush.
5. OSM tags and nodes in the world import, then `gd-traffic`.
6. Officers, orders and edits, decisions, checkpoints, seek, and determinism CI.
7. A flag in the app with side-by-side scorecards for one release. Then delete the TS movement and traffic code and wire `forecast.ts` to Node ensembles.

**`CLAUDE.md` lessons.**

- **Carry over:**
  - Step order and decision grouping (biggest groups first, one deadline, per-person records on the tape).
  - Field costs walk / sidewalk / road 12 / 11 / 32 (re-tune at 1 m).
  - Gate rules: fields built for shut gates, gates as outside arcs, a shut gate turns its queue away, reach measured along the field, no routes through the bowl.
  - Bowl rules: the bowl shell, inside not simulated, turnstile = seat.
  - Even gate quotas and reachable-gate assignment, until `pick_gate` becomes a decision.
  - Officer rules: start on streets, walk, instruct on arrival, repeat every 90 s; admitted fans ignore gate redirects.
  - Traffic rules: escape-only closures, EMS waits, entries only to lots with stalls, driveway inference, read-only traffic on its own RNG.
  - Rewind rules: checkpoints with non-contract state, re-applied closures, replayed orders and edits, a seek drops later checkpoints.
  - Off-map people are excluded.
  - Scoring rules: standing density for danger, `safeCountFor` 0.2 p/m², scoring from `incident.at`, game-end hooks, the late rush taken from ordinary arrivals.
  - Host rules: no `push(...bigArray)`, frames in refs.
- **Change:**
  - Speed lookup → emergent fundamental diagram (and fix the stale `CLAUDE.md` line that calls the curve linear).
  - `MAX_DOTS_PER_CELL` → physical exclusion.
  - Sidesteps, detours and corner escapes → CSM plus a stuck detector (re-plan after 60 s below 0.05 m/s; assumption).
  - Gate rate + burst bank + officer % → servers.
  - Cell cars + squeeze → IDM/MOBIL with don't-block-the-box.
  - Rebuild occupancy every pass → rebuild the hash every step (same principle).
- **Retire:** `DOT_GROUP_SIZE`, `SEATED_PER_CELL`/`DECKS` as a density hack, the `Math.fround` fix, and the 1.25 p/m² density steps.

## 9. Requirements ENG-01…

1. **ENG-01** One agent per person (100k). *Why:* no dot jargon or density steps. *Source:* brief; 01 §1.4.
2. **ENG-02** CSM as the operational model; no force models. *Why:* collision-free and cheap. *Source:* [Tordeux](https://arxiv.org/abs/1512.05597); [GCFM](https://arxiv.org/abs/1008.4297).
3. **ENG-03** Dial u16 fields with gradient e0. *Why:* proven; CSM needs a smooth direction. *Source:* `flowfield.ts`.
4. **ENG-04** Fixed integer tick of 0.2 s; decisions, density and scoring at 1 s. *Why:* determinism and budget; ≤4% from 0.1 s. *Source:* §7, measured.
5. **ENG-05** r 0.15 m and T 1 s, calibrated in CI against Weidmann and Jülich. *Why:* r 0.2 m ran 30–40% slow. *Source:* §7; [JuPedSim](https://github.com/PedestrianDynamics/jupedsim/blob/master/python_modules/jupedsim/tests/test_model_defaults.py).
6. **ENG-06** Same seed + tape gives an equal state hash at every checkpoint across native, wasm, Chrome and Node. *Why:* hard rule; shown feasible. *Source:* brief; §7.
7. **ENG-07** Lints ban FMA, relaxed SIMD, platform libm and HashMap iteration. *Why:* each breaks reproducibility. *Source:* [Nondeterminism.md](https://github.com/WebAssembly/design/blob/main/Nondeterminism.md); [RandomState](https://doc.rust-lang.org/stable/std/collections/hash_map/struct.RandomState.html).
8. **ENG-08** Counter-based RNG streams per subsystem and entity. *Why:* a new feature never shifts other draws. *Source:* `CLAUDE.md`.
9. **ENG-09** Jacobi update and fixed-order reductions. *Why:* order-independent; threads stay possible. *Source:* §6.
10. **ENG-10** RiMEA 1–16, IMO 1–12 and NIST Verif.* as CI tests with a published report. *Why:* credibility. *Source:* §3.
11. **ENG-11** Report claims as distributions over ≥50 runs (95th centile). *Why:* IMO, RiMEA and NIST statistics. *Source:* IMO App. 3.
12. **ENG-12** Validate only on data not used for calibration. *Why:* avoids circular validation. *Source:* [NIST TN 1822](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.1822.pdf) §3.2.
13. **ENG-13** Only derived Jülich fixtures, with a CC BY 4.0 notice. *Why:* licence and repo size. *Source:* [archive](https://ped.fz-juelich.de/da/doku.php).
14. **ENG-14** Gates are multi-lane servers with sampled service times and editable lane counts. *Why:* screening is the bottleneck. *Source:* [CISA](https://www.cisa.gov/sites/default/files/publications/patron-screening-guide-03-16-508.pdf); [DHS 2024](https://www.dhs.gov/sites/default/files/2024-09/24_0924_st_weaponsscreeningmsr_1.pdf).
15. **ENG-15** Ohio Stadium is no-bag, WTMD for all, wand on alarm. *Why:* actual policy. *Source:* [OSU A–Z](https://ohiostatebuckeyes.com/sports/2022/4/11/az-guide).
16. **ENG-16** Vehicles use IDM + MOBIL on an OSM lane graph. *Why:* realistic at ≤0.5 ms per step. *Source:* [IDM](https://arxiv.org/abs/cond-mat/0002177); [MOBIL](https://mtreiber.de/publications/MOBIL_TRB.pdf).
17. **ENG-17** The import keeps `oneway`, `maxspeed`, `lanes:*`, `turn:lanes` and tagged nodes. *Why:* the extract has none. *Source:* §4, counted.
18. **ENG-18** Signal, stop, yield and officer TCP controllers; contraflow with a flush. *Why:* police traffic plans. *Source:* §4.
19. **ENG-19** Vehicles never drive through people. *Why:* realism and safety. *Source:* `traffic.ts` lessons.
20. **ENG-20** Smoothed density (R 1 m), pressure and LoS as labelled indicators. *Why:* practice; CSM cannot predict turbulence. *Source:* [Helbing 2007](https://arxiv.org/abs/physics/0701203).
21. **ENG-21** One single-threaded worker per plan on stable Rust; no SharedArrayBuffer. *Why:* ≤9% slowdown measured; avoids COOP/COEP and nightly. *Source:* §7; [web.dev](https://web.dev/articles/coop-coep).
22. **ENG-22** Raw C-ABI exports and typed-array views. *Why:* a 35 KB module, identical in Node and browser. *Source:* §7.
23. **ENG-23** Checkpoints are mutable SoA only (~2.5 MB), versioned, with all non-contract state. *Why:* memory and exact rewinds. *Source:* §6; `CLAUDE.md`.
24. **ENG-24** Batched, columnar decision records. *Why:* ~290k per lightning delay. *Source:* §6, derived.
25. **ENG-25** Perf CI: ≤20 ms per step at 100k + 5k, failing on a >15% regression. *Why:* the ≥10× target. *Source:* §7.
26. **ENG-26** The same `.wasm` runs ensembles in Node. *Why:* forecasts and V&V statistics. *Source:* §7; `docs/forecast.md`.
27. **ENG-27** The UI states the model has no stop-and-go or turbulence. *Why:* honest labelling of assumptions. *Source:* Tordeux §4; brief.

## 10. Sources

Accessed October 2026 unless dated.

- **Models:**
  - [Helbing & Molnár 1995](https://arxiv.org/abs/cond-mat/9805244); [Helbing, Farkas & Vicsek 2000](https://arxiv.org/abs/cond-mat/0009448)
  - [Chraibi et al. 2010](https://arxiv.org/abs/1008.4297); [Tordeux et al. 2015](https://arxiv.org/abs/1512.05597); [Burstedde et al. 2001](https://arxiv.org/abs/cond-mat/0102397); [Seitz & Köster 2012](https://link.aps.org/doi/10.1103/PhysRevE.86.046108)
  - [Hughes 2002](https://www.researchgate.net/publication/222556037_A_continuum_theory_for_the_flow_of_pedestrians); [Treuille et al. 2006](http://www.ccs.neu.edu/home/scooper/index_files/pub/treuille2006continuum.pdf)
  - [UNC ORCA](https://gamma.cs.unc.edu/ORCA/); [RVO2](https://github.com/snape/RVO2); [Vadere](https://github.com/pedestrian-dynamics-HM/vadere)
  - JuPedSim [CSM source](https://github.com/PedestrianDynamics/jupedsim/blob/master/libsimulator/src/operational_models/collision_free_speed_model/collision_free_speed_model.hpp) and [defaults](https://github.com/PedestrianDynamics/jupedsim/blob/master/python_modules/jupedsim/tests/test_model_defaults.py)
  - [Seer & Matyus 2015](https://www.sne-journal.org/fileadmin/user_upload_sne/SNE_Issues_OA/SNE_25_1/articles/sne.25.1.10279.tn.OA.pdf)
- **Calibration:**
  - [Seyfried et al. 2005](https://arxiv.org/abs/physics/0506170); [Seyfried et al., bottlenecks](https://arxiv.org/abs/physics/0702004)
  - [Helbing et al. 2007](https://arxiv.org/abs/physics/0701203); [Johansson et al. 2008](https://arxiv.org/abs/0810.4590)
  - [Moussaïd et al. 2010](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0010047); [Fruin 1971](https://onlinepubs.trb.org/Onlinepubs/hrr/1971/355/355-001.pdf)
  - [Jülich archive](https://ped.fz-juelich.de/da/doku.php)
- **V&V:** [RiMEA 4.1.1](https://rimea.de/downloads/); [IMO MSC.1/Circ.1533](https://www.deutsche-flagge.de/de/redaktion/dokumente/interpretationen/solas/ii-2/msc-1-circ-1533-revised-guidelines-on-evacuation-analysis-for-new-and-existing-passenger-ships.pdf); [NIST TN 1822](https://nvlpubs.nist.gov/nistpubs/TechnicalNotes/NIST.TN.1822.pdf); [MassMotion V&V 2024](https://www.oasys-software.com/wp-content/uploads/2024/07/Fire-Evacuation-VV.pdf)
- **Vehicles:** [IDM](https://arxiv.org/abs/cond-mat/0002177); [MOBIL](https://mtreiber.de/publications/MOBIL_TRB.pdf); [Treiber & Kanagaraj 2015](https://arxiv.org/abs/1403.4881)
- **Screening:**
  - [CISA 2016](https://www.cisa.gov/sites/default/files/publications/patron-screening-guide-03-16-508.pdf); [CISA screening 2026](https://www.cisa.gov/sites/default/files/2026-08/FINAL_Public_Venue_Security_Screening_AUG2026_508.pdf); [CISA bag search 2026](https://www.cisa.gov/sites/default/files/2026-08/FINAL_Public_Venue_Bag_Search_Procedures_AUG2026_508.pdf)
  - [SAVER WTMD 2014](https://www.dhs.gov/sites/default/files/publications/WTMD-MSR_0614-508.pdf); [DHS TechNote 2024](https://www.dhs.gov/sites/default/files/2024-05/24_0522_st_weaponsscreeningtechnote.pdf); [DHS market survey 2024](https://www.dhs.gov/sites/default/files/2024-09/24_0924_st_weaponsscreeningmsr_1.pdf)
  - [OSU A–Z](https://ohiostatebuckeyes.com/sports/2022/4/11/az-guide)
- **WebAssembly and Rust:**
  - [Jangda et al. 2019](https://www.usenix.org/conference/atc19/presentation/jangda)
  - [Nondeterminism.md](https://github.com/WebAssembly/design/blob/main/Nondeterminism.md); [relaxed-simd](https://github.com/WebAssembly/relaxed-simd); [Wasmtime determinism](https://docs.wasmtime.dev/examples-deterministic-wasm-execution.html)
  - [web.dev COOP/COEP](https://web.dev/articles/coop-coep); [wasm-bindgen threads](https://rustwasm.github.io/docs/wasm-bindgen/examples/raytrace.html); [wasm-bindgen-rayon](https://github.com/RReverser/wasm-bindgen-rayon)
  - [Rust RandomState](https://doc.rust-lang.org/stable/std/collections/hash_map/struct.RandomState.html)
- **Measured:** `/projects/sandbox/.scratch/engine-bench/` (`src/lib.rs`, `bench.mjs`, `bench-results.jsonl`), October 2026.

Content was rephrased for compliance with licensing restrictions.
