import { useEffect, useMemo, useRef, useState } from 'react';
import type { Briefing, DecisionDefaults, Incident, MapBundle, ResponsePlan, Scorecard, SimConfig, VehicleKind } from '../../contracts.ts';
import { CELL_SIZE_M, DEFAULT_DANGER_DENSITY, DOT_GROUP_SIZE, FRAME_EVERY_S, VEHICLE_KINDS, VEHICLE_STATES } from '../../contracts.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { INCIDENT_LABELS, incidentsFor, windowFor } from '../../world/src/incidents.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { DEFAULT_VEHICLES, VEHICLE_TYPES, VEHICLE_TYPE_LIST } from '../../world/src/vehicles.ts';
import { WEATHER_TIMELINES, weatherTimeline } from '../../world/src/weather.ts';
import { getBriefing, getDecisionDefaults, getMap, saveComparison } from './api.ts';
import { ComparisonMaps, type FocusBox, type MapPick } from './ComparisonMaps.tsx';
import { bandTotals, heatBands, hotspots, makePlaceIndex, type Hotspot } from './heat.ts';
import { applyDisabled, PlanEditor } from './PlanEditor.tsx';
import { useRun, type RunHandle, type RunInit } from './useRun.ts';
import { vehicleIcon } from './vehicleArt.ts';

/** One seed for every plan in a comparison: the whole point is the same crowd. */
const SEED = 20251023;
const LABELS = ['A', 'B', 'C'] as const;
const params = new URLSearchParams(window.location.search);
/**
 * The server serves the stadium map when it has been fetched, else the test
 * map. `?map=test-3gate` forces the small one, which is handy for a quick look.
 */
const MAP_ID = params.get('map') ?? 'default';
/** `?autorun=1` starts the three runs without a click, for an unattended demo. */
const AUTORUN = params.get('autorun') === '1';
/** `?weather=thunderstorm` and `?traffic=0` set the scenario from the URL. */
const START_WEATHER = params.get('weather') ?? 'clear';
const START_TRAFFIC = params.get('traffic') !== '0';
const STADIUM_FANS = 100_000;
const TEST_FANS = 1200;
const OFFICERS = 24;

const fanCount = (map: MapBundle) => (map.width > 200 ? STADIUM_FANS : TEST_FANS);
const hasRoads = (map: MapBundle) => map.width > 200;
const minutes = (seconds: number) => `${seconds < 0 ? '−' : '+'}${Math.abs(Math.round(seconds / 60))} min`;
const fmt = (n: number) => Math.round(n).toLocaleString();

interface Loaded {
  map: MapBundle;
  defaults: DecisionDefaults;
}

interface PlanState {
  plan: ResponsePlan;
  disabled: Set<number>;
}

function ScorecardView({ card, live }: { card: Scorecard | null; live: RunHandle }) {
  return (
    <div className="scorecard">
      <dl>
        <dt>sim clock</dt>
        <dd>{minutes(live.t)}</dd>
        <dt>decisions</dt>
        <dd>
          {live.decisionCount.toLocaleString()}
          {live.kevCount > 0 && <span className="tag kev">{live.kevCount.toLocaleString()} Kev</span>}
        </dd>
        <dt>{card ? 'fallback decisions' : 'fallbacks so far'}</dt>
        {/* The scorecard counts one fallback per decision the run had to guess;
            the live tally counts every dot that acted on one, which is a much
            bigger number. Showing the live tally after the run finished made
            the panel disagree with the briefing, which quotes the scorecard. */}
        <dd className={(card ? card.fallbackDecisions : live.fallbackCount) > 0 ? 'warn' : undefined}>
          {(card ? card.fallbackDecisions : live.fallbackCount).toLocaleString()}
          {card && live.fallbackCount > 0 && (
            <span className="tag muted-tag">{live.fallbackCount.toLocaleString()} dots</span>
          )}
        </dd>
        {card ? (
          <>
            <dt>time to clear</dt>
            <dd>{card.timeToClearMin === null ? 'not cleared' : `${Math.round(card.timeToClearMin)} min`}</dd>
            <dt>peak density</dt>
            <dd>{card.peakDensity.toFixed(2)} /m²</dd>
            <dt>danger minutes</dt>
            <dd>{Math.round(card.dangerMinutes).toLocaleString()}</dd>
            <dt>first officer</dt>
            <dd>{card.firstOfficerMin === null ? 'none' : `${card.firstOfficerMin.toFixed(1)} min`}</dd>
            <dt>officer minutes</dt>
            <dd>{Math.round(card.officerMinutesUsed).toLocaleString()}</dd>
            <dt>fans not reached</dt>
            <dd>{card.fansNotReached.toLocaleString()}</dd>
            {card.vehicleDelayMin !== undefined && (
              <>
                <dt className="section">ambulance on scene</dt>
                <dd className={card.emergencyResponseMin === null ? 'warn section' : 'section'}>
                  {card.emergencyResponseMin === undefined
                    ? '—'
                    : card.emergencyResponseMin === null
                      ? 'never reached'
                      : `${card.emergencyResponseMin.toFixed(1)} min`}
                </dd>
                <dt>vehicle delay</dt>
                <dd>{fmt(card.vehicleDelayMin)} veh-min</dd>
                <dt>peak vehicles stopped</dt>
                <dd>{fmt(card.peakVehiclesStopped ?? 0)}</dd>
                <dt>vehicles out</dt>
                <dd>{fmt(card.vehiclesOut ?? 0)}</dd>
              </>
            )}
          </>
        ) : (
          <>
            <dt className="muted">scorecard</dt>
            <dd className="muted">at end of run</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function VehicleIcon({ kind }: { kind: VehicleKind }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) vehicleIcon(kind, ref.current, 1);
  }, [kind]);
  return <canvas ref={ref} className="vehicle-icon" />;
}

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [incidentIndex, setIncidentIndex] = useState(0);
  const [planStates, setPlanStates] = useState<PlanState[]>([]);
  const [generation, setGeneration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [savedComparison, setSavedComparison] = useState<string | null>(null);
  const [speed, setSpeed] = useState(20);
  const [scrub, setScrub] = useState<number | null>(null);
  const [picked, setPicked] = useState<MapPick | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [briefingBusy, setBriefingBusy] = useState(false);
  const [weatherId, setWeatherId] = useState(START_WEATHER);
  const [trafficOn, setTrafficOn] = useState(START_TRAFFIC);
  const [showVehicles, setShowVehicles] = useState(true);
  const [vehicleFocus, setVehicleFocus] = useState<VehicleKind | null>(null);
  const [selectedBand, setSelectedBand] = useState<number | null>(null);
  const [focus, setFocus] = useState<FocusBox | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const map = await getMap(MAP_ID);
        const defaults = await getDecisionDefaults();
        setLoaded({ map, defaults });
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, []);

  const incidents = useMemo<Incident[]>(() => (loaded ? incidentsFor(loaded.map) : []), [loaded]);
  const incident = incidents[incidentIndex];
  const placeIndex = useMemo(() => (loaded ? makePlaceIndex(loaded.map) : null), [loaded]);
  const bands = useMemo(() => heatBands(DEFAULT_DANGER_DENSITY), []);

  const resetView = () => {
    setPlaying(false);
    setScrub(null);
    setBriefing(null);
    setPicked(null);
    setSavedComparison(null);
  };

  // Picking an incident loads its playbook as editable copies.
  useEffect(() => {
    if (!loaded || !incident) return;
    const plans = playbookFor(incident.kind, loaded.map).slice(0, 3);
    setPlanStates(plans.map((plan) => ({ plan, disabled: new Set<number>() })));
    resetView();
    setGeneration((g) => g + 1);
  }, [loaded, incident]);

  // The sky and the traffic are part of the moment, not the plan: changing
  // either restarts all three runs on the same seed.
  const firstScenario = useRef(true);
  useEffect(() => {
    if (firstScenario.current) {
      firstScenario.current = false;
      return;
    }
    resetView();
    setGeneration((g) => g + 1);
  }, [weatherId, trafficOn]);

  const inits = useMemo<(RunInit | null)[]>(() => {
    if (!loaded || !incident || planStates.length === 0) return [null, null, null];
    const population = makePopulation(fanCount(loaded.map), SEED);
    const officers = makeOfficers(loaded.map, OFFICERS);
    const window = windowFor(incident);
    const weather = weatherTimeline(weatherId);
    const traffic = trafficOn && hasRoads(loaded.map) ? { vehicles: DEFAULT_VEHICLES, seed: SEED ^ 0x7a11c, emergencyResponse: true } : undefined;
    void generation; // a new generation means fresh workers on the same seed
    return LABELS.map((label, i) => {
      const state = planStates[i];
      if (!state) return null;
      const config: SimConfig = {
        runId: `run-${label}-${generation}`,
        label,
        seed: SEED,
        startAt: window.startAt,
        endAt: window.endAt,
        speed,
        dangerDensity: DEFAULT_DANGER_DENSITY,
        mapId: loaded.map.id,
        incident,
        plan: applyDisabled(state.plan, state.disabled),
        officers,
        traffic,
        weather,
      };
      return { config, map: loaded.map, population, defaults: loaded.defaults };
    });
    // speed is deliberately out of the dependency list: it is sent live below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, incident, planStates, generation]);

  // Fixed count of hooks, one per comparison slot.
  const runA = useRun(inits[0] ?? null);
  const runB = useRun(inits[1] ?? null);
  const runC = useRun(inits[2] ?? null);
  const runs = [runA, runB, runC];

  useEffect(() => {
    for (const run of runs) {
      if (!run.ready) continue;
      run.send({ type: playing ? 'play' : 'pause' });
    }
  }, [playing, runA.ready, runB.ready, runC.ready]);

  useEffect(() => {
    for (const run of runs) if (run.ready) run.send({ type: 'speed', speed });
  }, [speed, runA.ready, runB.ready, runC.ready]);

  const cards = runs.map((r) => r.scorecard);
  const allDone = cards.every((c) => c !== null);

  // Start without a click when asked, once all three workers are ready.
  useEffect(() => {
    if (!AUTORUN || playing || !loaded) return;
    if (!runs.every((r) => r.ready)) return;
    setPlaying(true);
  }, [loaded, playing, runA.ready, runB.ready, runC.ready]);

  // Keep the finished comparison, which is what POST /comparisons is for.
  useEffect(() => {
    if (!allDone || !incident || savedComparison) return;
    const scorecards = cards.filter((c): c is Scorecard => c !== null);
    void saveComparison(incident, scorecards)
      .then((r) => setSavedComparison(r.id))
      .catch(() => {});
  }, [allDone, incident, savedComparison, cards]);
  const maxFrames = Math.max(...runs.map((r) => r.frameCount), 0);

  // The briefing is only worth asking for once every plan has a scorecard.
  useEffect(() => {
    if (!allDone || !incident || briefing || briefingBusy) return;
    const scorecards = cards.filter((c): c is Scorecard => c !== null);
    setBriefingBusy(true);
    void getBriefing({ incident, plans: planStates.map((p) => applyDisabled(p.plan, p.disabled)), scorecards })
      .then(setBriefing)
      .catch(() => setBriefing(null))
      .finally(() => setBriefingBusy(false));
  }, [allDone, incident, briefing, briefingBusy, cards, planStates]);

  /** The frame on screen for a run: the scrubbed one, or the latest. */
  const shown = (run: RunHandle) => {
    const kept = run.frames.current ?? [];
    return scrub === null ? run.latest.current : (kept[Math.min(scrub, kept.length - 1)] ?? run.latest.current);
  };
  const ticks = runs.map((r) => r.tick).join(',');

  // Density bands per run, for the legend counts and the area table.
  const totals = useMemo(
    () => runs.map((run) => {
      const density = shown(run)?.density;
      return density ? bandTotals(density.peoplePerM2, bands) : null;
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ticks, scrub, bands],
  );

  // Where the selected colour is, run by run.
  const spots = useMemo<(Hotspot[] | null)[]>(() => {
    if (selectedBand === null || !loaded || !placeIndex) return [null, null, null];
    return runs.map((run) => {
      const density = shown(run)?.density;
      return density ? hotspots(density.peoplePerM2, loaded.map, bands[selectedBand]!, placeIndex, 4) : null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticks, scrub, selectedBand, loaded, placeIndex, bands]);

  const vehicleCounts = useMemo(() => {
    const counts = new Map<VehicleKind, number>();
    const v = shown(runA)?.frame.vehicles;
    if (!v) return counts;
    const gone = VEHICLE_STATES.indexOf('gone');
    const waiting = VEHICLE_STATES.indexOf('waiting');
    for (let i = 0; i < v.kind.length; i++) {
      if (v.state[i] === gone || v.state[i] === waiting) continue;
      const k = VEHICLE_KINDS[v.kind[i]!]!;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticks, scrub]);

  const zoomTo = (h: Hotspot) => setFocus({ x0: h.x0, y0: h.y0, x1: h.x1, y1: h.y1, nonce: Date.now() });

  // Published for an unattended run: a browser with no debugger attached can
  // still be checked, because the server sees the saved comparison.
  useEffect(() => {
    (window as unknown as { gameday?: unknown }).gameday = {
      mapId: loaded?.map.id ?? null,
      incident: incident?.kind ?? null,
      weather: weatherId,
      traffic: trafficOn,
      allDone,
      savedComparison,
      briefing: briefing ? { canned: briefing.canned, model: briefing.model } : null,
      /** Vehicles in a run doing something, for pointing the camera at them in a check. */
      vehiclesIn: (run: number, state: string) => {
        const v = runs[run]?.latest.current?.frame.vehicles;
        if (!v) return [];
        const out: { i: number; kind: string; x: number; y: number }[] = [];
        for (let i = 0; i < v.state.length; i++) {
          if (VEHICLE_STATES[v.state[i]!] === state) out.push({ i, kind: VEHICLE_KINDS[v.kind[i]!]!, x: v.x[i]!, y: v.y[i]! });
        }
        return out;
      },
      runs: runs.map((r, i) => ({
        label: LABELS[i],
        ready: r.ready,
        t: r.t,
        frames: r.frameCount,
        scorecard: r.scorecard,
        snapshotAt: r.snapshotAt,
        snapshotDots: r.snapshotDots,
        fallbacksSoFar: r.fallbackCount,
      })),
    };
  });

  const pickedRecord = picked?.type === 'dot' ? runs[picked.run]?.decisionsByDot.current?.get(picked.dot) : undefined;
  const pickedVehicle = (() => {
    if (picked?.type !== 'vehicle') return null;
    const v = shown(runs[picked.run]!)?.frame.vehicles;
    if (!v) return null;
    const i = picked.vehicle;
    return {
      type: VEHICLE_TYPES[VEHICLE_KINDS[v.kind[i]!]!],
      state: VEHICLE_STATES[v.state[i]!]!,
      speed: v.speed[i]!,
      waited: v.waitedS[i]!,
    };
  })();

  return (
    <>
      <header className="top">
        <div className="brand">
          <span className="logo">GC</span>
          <h1>Gameday Command</h1>
        </div>
        <span className="sub">
          {loaded
            ? `${loaded.map.name} · ${fanCount(loaded.map).toLocaleString()} fans as ${(fanCount(loaded.map) / DOT_GROUP_SIZE).toLocaleString()} dots${trafficOn && hasRoads(loaded.map) ? ` · ${DEFAULT_VEHICLES.toLocaleString()} vehicles` : ''} · seed ${SEED}`
            : 'loading map…'}
        </span>
        <div className="controls">
          <label>
            weather
            <select value={weatherId} onChange={(e) => setWeatherId(e.target.value)}>
              {WEATHER_TIMELINES.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <label className="toggle" title="Simulate vehicle traffic alongside the crowd">
            <input type="checkbox" checked={trafficOn} onChange={(e) => setTrafficOn(e.target.checked)} disabled={!loaded || !hasRoads(loaded.map)} />
            vehicles
          </label>
          <label>
            speed
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {[1, 5, 10, 20, 60].map((s) => (
                <option key={s} value={s}>
                  {s}x
                </option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={() => setPlaying((p) => !p)} disabled={!loaded}>
            {playing ? 'Pause all three' : 'Run all three'}
          </button>
          <button
            onClick={() => {
              resetView();
              setGeneration((g) => g + 1);
            }}
            disabled={!loaded}
          >
            Reset
          </button>
        </div>
      </header>

      <p className="assumption">
        Fan behavior, traffic and weather in this tool are an <strong>assumption, not a forecast</strong>. It shows the
        tradeoffs between plans on the same crowd, the same cars, the same sky and the same seed. The commander makes the
        call.
      </p>

      {loadError && (
        <p className="assumption error">
          Could not reach the server: {loadError}. Start it with <code>npm run serve</code>.
        </p>
      )}

      <div className="layout">
        <aside className="side">
          <section className="panel">
            <h2>Incident</h2>
            {incidents.map((candidate, i) => (
              <label key={candidate.id} className={`incident${i === incidentIndex ? ' on' : ''}`}>
                <input type="radio" name="incident" checked={i === incidentIndex} onChange={() => setIncidentIndex(i)} />
                <span>
                  <strong>{INCIDENT_LABELS[candidate.kind]}</strong>
                  <em>{minutes(candidate.at)} from kickoff</em>
                  {candidate.note && <span className="note">{candidate.note}</span>}
                </span>
              </label>
            ))}
          </section>

          <section className="panel">
            <h2>Playbook</h2>
            <p className="muted">Three plans, run side by side on the identical crowd. Edit the steps, then run again.</p>
            {planStates.map((state, i) => (
              <div className="plan" key={state.plan.id}>
                <h3>
                  <span className="label">{LABELS[i]}</span> {state.plan.name}
                </h3>
                <PlanEditor
                  plan={state.plan}
                  disabled={state.disabled}
                  onChange={(plan, disabled) =>
                    setPlanStates((prev) => prev.map((p, j) => (j === i ? { plan, disabled } : p)))
                  }
                />
              </div>
            ))}
            <button
              onClick={() => {
                resetView();
                setGeneration((g) => g + 1);
              }}
              disabled={!loaded}
            >
              Apply edits and restart
            </button>
          </section>
        </aside>

        <main>
          {loaded && (
            <div className="compare">
              <div className="canvas-wrap">
                <ComparisonMaps
                  map={loaded.map}
                  runs={runs}
                  scrubIndex={scrub}
                  dangerDensity={DEFAULT_DANGER_DENSITY}
                  incidentCells={incident?.cells}
                  playing={playing}
                  selectedBand={selectedBand}
                  vehicleFocus={vehicleFocus}
                  showVehicles={showVehicles}
                  picked={picked}
                  focus={focus}
                  onPick={(pick) => {
                    setPicked(pick);
                    if (pick?.type === 'cell') setSelectedBand(pick.band);
                  }}
                />
                {runs.some((r) => r.deciding !== null) && (
                  <div className="deciding">
                    deciding… {runs.reduce((n, r) => n + (r.deciding ?? 0), 0)} groups
                  </div>
                )}
                {scrub !== null && <div className="replaying">replay</div>}
                <div className="map-hint">scroll to zoom · drag to pan · click a fan, a vehicle or a colour</div>
              </div>

              <div className="legend-bar">
                <div className="legend-group">
                  <span className="legend-title">Crowd density</span>
                  {bands.map((band) => {
                    const total = totals.reduce((n, t) => n + (t?.[band.id]?.people ?? 0), 0) / 3;
                    return (
                      <button
                        key={band.id}
                        className={`band-chip${selectedBand === band.id ? ' on' : ''}${selectedBand !== null && selectedBand !== band.id ? ' off' : ''}`}
                        onClick={() => setSelectedBand(selectedBand === band.id ? null : band.id)}
                        title={band.note}
                      >
                        <i style={{ background: `rgb(${band.rgb.join(',')})` }} />
                        <span>
                          <strong>{band.label}</strong>
                          <em>{band.range}</em>
                        </span>
                        {total > 0 && <b>{fmt(total)}</b>}
                      </button>
                    );
                  })}
                </div>
                <div className="legend-group fans">
                  <span className="legend-title">Fans</span>
                  <span><i style={{ background: '#b4f07a' }} /> walking</span>
                  <span><i style={{ background: '#ffc45c' }} /> queued</span>
                  <span><i style={{ background: '#ff7aa8' }} /> sheltering</span>
                  <span><i style={{ background: '#7ddfff' }} /> seated</span>
                  <span><i className="officer" /> officer</span>
                </div>
              </div>

              <div className="runs">
                {runs.map((run, i) => (
                  <section className="run" key={LABELS[i]}>
                    <h2>
                      <span className="label">{LABELS[i]}</span>
                      <span className="plan-name">{planStates[i]?.plan.name ?? 'no plan'}</span>
                    </h2>
                    <ScorecardView card={run.scorecard} live={run} />
                    {run.error && <p className="error">{run.error}</p>}
                  </section>
                ))}
              </div>
            </div>
          )}

          {loaded && hasRoads(loaded.map) && trafficOn && (
            <section className="panel wide vehicles-panel">
              <h2>
                Vehicles <span className="muted-inline">drawn to scale · click one to focus</span>
                <label className="toggle small-toggle">
                  <input type="checkbox" checked={showVehicles} onChange={(e) => setShowVehicles(e.target.checked)} /> show on map
                </label>
              </h2>
              <div className="vehicle-grid">
                {VEHICLE_TYPE_LIST.map((type) => (
                  <button
                    key={type.kind}
                    className={`vehicle-chip${vehicleFocus === type.kind ? ' on' : ''}${vehicleFocus !== null && vehicleFocus !== type.kind ? ' off' : ''}`}
                    onClick={() => setVehicleFocus(vehicleFocus === type.kind ? null : type.kind)}
                  >
                    <VehicleIcon kind={type.kind} />
                    <span className="vehicle-name">{type.label}</span>
                    <span className="vehicle-size">
                      {type.lengthM.toFixed(1)} × {type.widthM.toFixed(1)} m · {type.passengers} aboard
                    </span>
                    <span className="vehicle-count">{(vehicleCounts.get(type.kind) ?? 0).toLocaleString()} on map (A)</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="panel wide areas-panel">
            <h2>
              Density areas{' '}
              <span className="muted-inline">
                {selectedBand === null ? 'click a colour on the map or in the legend' : `${bands[selectedBand]!.label} · ${bands[selectedBand]!.range}`}
              </span>
              {selectedBand !== null && (
                <button className="small" onClick={() => setSelectedBand(null)}>
                  Show all colours
                </button>
              )}
            </h2>
            <table className="areas">
              <thead>
                <tr>
                  <th>band</th>
                  {LABELS.map((l, i) => (
                    <th key={l}>
                      <span className="label">{l}</span> {planStates[i]?.plan.name ?? ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bands.map((band) => (
                  <tr
                    key={band.id}
                    className={selectedBand === band.id ? 'on' : undefined}
                    onClick={() => setSelectedBand(selectedBand === band.id ? null : band.id)}
                  >
                    <td>
                      <i className="swatch" style={{ background: `rgb(${band.rgb.join(',')})` }} /> {band.label}
                      <em>{band.range}</em>
                    </td>
                    {totals.map((t, i) => (
                      <td key={i}>
                        {t ? (
                          <>
                            <strong>{fmt(t[band.id]!.people)}</strong> people
                            <em>{fmt(t[band.id]!.cells * CELL_SIZE_M * CELL_SIZE_M)} m²</em>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {selectedBand !== null && (
              <div className="spots">
                {spots.map((list, i) => (
                  <div key={i} className="spot-col">
                    <h3>
                      <span className="label">{LABELS[i]}</span> biggest {bands[selectedBand]!.label.toLowerCase()} areas
                    </h3>
                    {!list && <p className="muted">no frame yet</p>}
                    {list && list.length === 0 && <p className="muted">none right now</p>}
                    {list?.map((h, k) => (
                      <button key={k} className="spot" onClick={() => zoomTo(h)}>
                        <span className="where">{h.where}</span>
                        <span className="nums">
                          {fmt(h.people)} people · {fmt(h.cells * CELL_SIZE_M * CELL_SIZE_M)} m² · peak {h.peak.toFixed(1)}/m²
                        </span>
                        <span className="go">zoom ↗</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel wide">
            <h2>Replay</h2>
            <div className="scrubber">
              <input
                type="range"
                min={0}
                max={Math.max(0, maxFrames - 1)}
                value={scrub ?? Math.max(0, maxFrames - 1)}
                disabled={maxFrames === 0}
                onChange={(e) => setScrub(Number(e.target.value))}
              />
              <span className="muted">
                {maxFrames === 0
                  ? 'no frames yet'
                  : scrub === null
                    ? `live · ${maxFrames} frames, one every ${FRAME_EVERY_S}s`
                    : `frame ${scrub + 1} of ${maxFrames}`}
              </span>
              {scrub !== null && (
                <>
                  <button
                    onClick={() => {
                      // Rewind the simulations themselves, not just the picture:
                      // each worker restores its nearest checkpoint and steps
                      // forward, so play resumes from this moment.
                      const at = scrub;
                      const frame = runs
                        .map((r) => r.frames.current?.[at])
                        .find((f) => f !== undefined);
                      if (!frame) return;
                      setPlaying(false);
                      setBriefing(null);
                      setSavedComparison(null);
                      for (const run of runs) run.seekTo(frame.frame.t);
                      setScrub(null);
                    }}
                    className="small"
                  >
                    Rewind runs to here
                  </button>
                  <button onClick={() => setScrub(null)} className="small">
                    Back to live
                  </button>
                </>
              )}
            </div>
          </section>

          <div className="bottom">
            <section className="panel">
              <h2>Briefing</h2>
              {briefingBusy && <p className="muted">asking the on-device model…</p>}
              {!briefingBusy && !briefing && <p className="muted">Runs all three plans, then writes the briefing.</p>}
              {briefing && (
                <>
                  <p className="briefing-text">{briefing.text}</p>
                  <p className="muted">
                    {briefing.canned
                      ? 'Template — the model was unavailable or cited a number that is not on a scorecard.'
                      : `Written by ${briefing.model}; every number checked against the scorecards.`}
                  </p>
                </>
              )}
            </section>

            <section className="panel">
              <h2>Inspector</h2>
              {!picked && <p className="muted">Click a fan, a vehicle, or any colour on a map.</p>}

              {picked?.type === 'dot' && !pickedRecord && (
                <p className="muted">
                  Dot {picked.dot} in run {LABELS[picked.run]} has not hit a decision yet — it is still walking its
                  flow field.
                </p>
              )}
              {picked?.type === 'dot' && pickedRecord && (
                <dl className="detail">
                  <dt>dot</dt>
                  <dd>
                    {picked.dot} (run {LABELS[picked.run]}, {DOT_GROUP_SIZE} fans)
                  </dd>
                  <dt>fan type</dt>
                  <dd>{pickedRecord.fanTypeId}</dd>
                  <dt>situation</dt>
                  <dd>{pickedRecord.situation.replace(/_/g, ' ')}</dd>
                  <dt>chose</dt>
                  <dd>
                    <strong>{pickedRecord.picked}</strong>
                  </dd>
                  <dt>odds</dt>
                  <dd>
                    {Object.entries(pickedRecord.odds)
                      .map(([key, value]) => `${key} ${Math.round(value * 100)}%`)
                      .join(', ')}
                  </dd>
                  <dt>answered by</dt>
                  <dd className={pickedRecord.source === 'default' ? 'warn' : undefined}>
                    {pickedRecord.source === 'default' ? 'fallback defaults' : pickedRecord.source}
                  </dd>
                  <dt>group key</dt>
                  <dd className="key">{pickedRecord.key}</dd>
                </dl>
              )}

              {picked?.type === 'vehicle' && pickedVehicle && (
                <div className="vehicle-detail">
                  <VehicleIcon kind={pickedVehicle.type.kind} />
                  <dl className="detail">
                    <dt>vehicle</dt>
                    <dd>
                      <strong>{pickedVehicle.type.label}</strong> #{picked.vehicle} (run {LABELS[picked.run]})
                    </dd>
                    <dt>size</dt>
                    <dd>
                      {pickedVehicle.type.lengthM.toFixed(1)} m long × {pickedVehicle.type.widthM.toFixed(1)} m wide
                    </dd>
                    <dt>aboard</dt>
                    <dd>about {pickedVehicle.type.passengers}</dd>
                    <dt>doing</dt>
                    <dd className={pickedVehicle.state === 'stopped' ? 'warn' : undefined}>{pickedVehicle.state.replace(/_/g, ' ')}</dd>
                    <dt>speed</dt>
                    <dd>{Math.round(pickedVehicle.speed * 2.237)} mph</dd>
                    <dt>time stopped</dt>
                    <dd>{pickedVehicle.waited < 60 ? `${Math.round(pickedVehicle.waited)} s` : `${(pickedVehicle.waited / 60).toFixed(1)} min`}</dd>
                  </dl>
                </div>
              )}

              {picked?.type === 'cell' && placeIndex && (
                <dl className="detail">
                  <dt>colour</dt>
                  <dd>
                    <i className="swatch" style={{ background: `rgb(${bands[picked.band]!.rgb.join(',')})` }} />{' '}
                    <strong>{bands[picked.band]!.label}</strong> · {bands[picked.band]!.range}
                  </dd>
                  <dt>here</dt>
                  <dd>
                    {picked.density.toFixed(2)} people/m² · {placeIndex.describe(picked.cell)} (run {LABELS[picked.run]})
                  </dd>
                  <dt>means</dt>
                  <dd>{bands[picked.band]!.note}</dd>
                  <dt>on the maps</dt>
                  <dd>Every area in this band is highlighted; the list above shows where.</dd>
                </dl>
              )}
            </section>
          </div>
        </main>
      </div>
    </>
  );
}
