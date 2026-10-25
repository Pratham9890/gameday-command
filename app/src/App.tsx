import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Briefing, DecisionDefaults, Incident, MapBundle, ResponsePlan, Scorecard, SimConfig, VehicleKind } from '../../contracts.ts';
import { CELL_SIZE_M, DEFAULT_DANGER_DENSITY, DOT_GROUP_SIZE, FRAME_EVERY_S, VEHICLE_KINDS, VEHICLE_STATES } from '../../contracts.ts';
import { FAN_TYPES, makePopulation } from '../../brain/src/fan-types.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { INCIDENT_LABELS, incidentsFor, windowFor } from '../../world/src/incidents.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { DEFAULT_VEHICLES, VEHICLE_TYPES, VEHICLE_TYPE_LIST } from '../../world/src/vehicles.ts';
import { WEATHER_TIMELINES, weatherTimeline } from '../../world/src/weather.ts';
import { getBriefing, getDecisionDefaults, getMap, saveComparison } from './api.ts';
import { ComparisonMaps, type FocusBox, type MapPick } from './ComparisonMaps.tsx';
import { CrowdView } from './CrowdView.tsx';
import { Inspector, type EditRequest } from './Inspector.tsx';
import { applyDisabled, describeAction, PlanEditor } from './PlanEditor.tsx';
import { CommandPanel } from './CommandPanel.tsx';
import { StartScreen } from './StartScreen.tsx';
import { applyTheme } from './theme.ts';
import { rankByPriority, stoppedPerStreet, streetIndex, type HistorySample, type Priority } from './command.ts';
import { OfficerPanel } from './OfficerPanel.tsx';
import { GatesPanel } from './GatesPanel.tsx';
import { stepStatus } from './live-steps.ts';
import { rgbCss, shirtColor, STATE_RGB } from './people.ts';
import { clearText, clockText, incidentStatus, liveStats, rankPlans, verdictText } from './story.ts';
import { HOTSPOT_COLOUR, policeHotspots, standingDensity, type PoliceHotspot } from './congestion.ts';
import { bandTotals, heatBands, hotspots, makePlaceIndex, type Hotspot } from './heat.ts';
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
/** `?map=` picks a stadium; with none (and no autorun) the app starts empty, on the stadium chooser. */
const MAP_PARAM = params.get('map');
/** `?autorun=1` starts the three runs without a click, for an unattended demo. */
const AUTORUN = params.get('autorun') === '1';
/** `?weather=thunderstorm` and `?traffic=0` set the scenario from the URL. */
const START_WEATHER = params.get('weather') ?? 'clear';
const START_TRAFFIC = params.get('traffic') !== '0';
const STADIUM_FANS = 100_000;
const TEST_FANS = 1200;
const OFFICERS = 24;
const SPEEDS = [5, 20, 60] as const;
const DANGER = DEFAULT_DANGER_DENSITY;

/** A stadium's crowd is its capacity, up to the 100,000 the engine is sized for. */
const fanCount = (map: MapBundle) =>
  map.width > 200 ? Math.min(STADIUM_FANS, Math.round((map.places.find((p) => p.kind === 'seating')?.capacity ?? STADIUM_FANS) / 5) * 5) : TEST_FANS;
/** The test map is a gate wall and a lot with no streets between them. */
const hasRoads = (map: MapBundle) => map.width > 200;
const minutes = (seconds: number) => `${seconds < 0 ? '−' : '+'}${Math.abs(Math.round(seconds / 60))} min`;
const n = (value: number) => Math.round(value).toLocaleString();

/** The situation in a sentence a judge gets on first read. */
function pitchFor(incident: Incident, zoneName: string): string {
  switch (incident.kind) {
    case 'gate_surge':
      return `A late rush piles up at ${zoneName} right at kickoff. Which plan spreads the crowd out before it gets dangerous?`;
    case 'lightning_delay':
      return 'Lightning 30 minutes into the game. Over 100,000 people in open stands have to get under cover. Which plan gets them there safely?';
    case 'suspicious_package':
      return 'An unattended bag closes a street just as the game lets out. Which plan gets everyone home without a crush?';
    default:
      return incident.note ?? INCIDENT_LABELS[incident.kind];
  }
}

/** The side rail's tabs, in the order a commander works through them. */
const RAIL_TABS = [
  { id: 'brief', label: 'Brief' },
  { id: 'plans', label: 'Plans' },
  { id: 'gates', label: 'Gates' },
  { id: 'key', label: 'Map key' },
  { id: 'about', label: 'About' },
] as const;
type RailTab = (typeof RAIL_TABS)[number]['id'];

interface Loaded {
  map: MapBundle;
  defaults: DecisionDefaults;
}

interface PlanState {
  plan: ResponsePlan;
  disabled: Set<number>;
}

/** A "?" that explains a number in plain words on hover or tap. */
function Info({ children }: { children: ReactNode }) {
  return (
    <span className="info" tabIndex={0}>
      ?<span className="info-pop">{children}</span>
    </span>
  );
}

function PlanCard({
  label,
  state,
  run,
  map,
  incident,
  totalFans,
  selected,
  rank,
  onSelect,
  onEdit,
}: {
  label: string;
  state: PlanState;
  run: RunHandle;
  map: MapBundle;
  incident: Incident;
  totalFans: number;
  selected: boolean;
  rank: number | null;
  onSelect: () => void;
  onEdit: (plan: ResponsePlan, disabled: Set<number>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const live = liveStats(run.latest.current?.density?.peoplePerM2, incident.cells, DANGER, run.latest.current?.frame, map.width);
  const alerts = state.plan.actions.some((a, i) => a.type === 'alert' && !state.disabled.has(i));
  const officers = state.plan.actions.some((a, i) => a.type === 'send_officers' && !state.disabled.has(i));
  const card = run.scorecard;
  const steps = state.plan.actions.map((action, i) => ({ action, i })).filter(({ i }) => !state.disabled.has(i));
  const started = run.t >= incident.at;

  return (
    <section className={`plan-card${selected ? ' selected' : ''}${rank === 0 ? ' best' : ''}`} onClick={onSelect}>
      <header>
        <span className="label">{label}</span>
        <h3>{state.plan.name}</h3>
        {rank === 0 && <span className="badge best">Best plan</span>}
        {selected && rank !== 0 && <span className="badge">on map</span>}
      </header>

      <ol className="plan-steps">
        {steps.length === 0 && <li className="muted">Does nothing. A baseline to compare against.</li>}
        {steps.map(({ action, i }) => {
          const done = run.t >= incident.at + action.at;
          const status = stepStatus(action, incident.at + action.at, run.t, run.scene.current, run.alerts.current ?? [], map);
          return (
            <li key={i} className={done ? 'done' : undefined}>
              <span className="tick">{done ? '✓' : ''}</span>
              {describeAction(action, map)}
              {action.at > 0 && <span className="muted"> after {Math.round(action.at / 60) || '<1'} min</span>}
              {status && <span className={`live ${action.type}`}>{status}</span>}
            </li>
          );
        })}
      </ol>

      {card ? (
        <dl className="results">
          <dt>
            Time to clear <Info>Minutes from the start of the incident until the crowd in the zone thinned out to safe levels. Lower is better.</Info>
          </dt>
          <dd className={card.timeToClearMin === null ? 'bad' : undefined}>{clearText(card)}</dd>
          {officers && (
            <>
              <dt>
                First officer on scene <Info>Minutes from the start of the incident until an officer reached the zone.</Info>
              </dt>
              <dd>{card.firstOfficerMin === null ? 'never' : `${card.firstOfficerMin.toFixed(1)} min`}</dd>
              <dt>
                Officer time used <Info>Officers committed, times how long. The staffing cost of the plan.</Info>
              </dt>
              <dd>{n(card.officerMinutesUsed)} min</dd>
            </>
          )}
          {card.vehicleDelayMin !== undefined && (
            <>
              <dt>
                Ambulance on scene <Info>Minutes from the start of the incident until the ambulance, driving in from the edge of the map, reached the zone. Crowds and closed streets slow it down.</Info>
              </dt>
              <dd className={card.emergencyResponseMin === null ? 'bad' : undefined}>
                {card.emergencyResponseMin == null ? 'never got there' : `${card.emergencyResponseMin.toFixed(1)} min`}
              </dd>
              <dt>
                Time stuck in traffic <Info>Every vehicle's minutes spent stopped, added up: behind other cars, at a closure, or waiting for a crowd to clear the road.</Info>
              </dt>
              <dd>{n(card.vehicleDelayMin)} vehicle-min</dd>
            </>
          )}
          {alerts && (
            <>
              <dt>
                Fans the alert reached <Info>How many fans actually got the PA announcement or phone alert.</Info>
              </dt>
              <dd>{n(Math.max(0, totalFans - card.fansNotReached))}</dd>
            </>
          )}
        </dl>
      ) : (
        <dl className="results">
          <dt>
            In the zone now <Info>People standing inside the yellow incident zone on the map right now.</Info>
          </dt>
          <dd>{run.ready ? n(live.zonePeople) : '…'}</dd>
          <dt>
            Dangerously packed <Info>People on their feet (not in a seat) anywhere on the map tighter than {DANGER} per m², where crowd crush becomes possible.</Info>
          </dt>
          <dd className={live.dangerPeople > 0 ? 'bad' : undefined}>{run.ready ? n(live.dangerPeople) : '…'}</dd>
          <dt className="muted">Result</dt>
          <dd className="muted">{started ? 'when the run ends' : 'after the incident'}</dd>
        </dl>
      )}

      <button
        className="link"
        onClick={(e) => {
          e.stopPropagation();
          setEditing((v) => !v);
        }}
      >
        {editing ? 'Done editing' : 'Edit this plan'}
      </button>
      {editing && (
        <div className="plan-edit" onClick={(e) => e.stopPropagation()}>
          <p className="muted">Switch steps off, or change when they happen and how many officers go.</p>
          <PlanEditor plan={state.plan} map={map} disabled={state.disabled} onChange={onEdit} />
        </div>
      )}
      {run.error && <p className="error">{run.error}</p>}
    </section>
  );
}

/** How long an alert's banner stays up, in sim seconds. */
const ALERT_BANNER_S = 120;

/** A banner over the map while an alert is going out: what was said, how, and to how many. */
function AlertBanner({ run, plan, incidentAt }: { run: RunHandle; plan: ResponsePlan; incidentAt: number }) {
  const alerts = run.alerts.current ?? [];
  const last = alerts[alerts.length - 1];
  if (!last || run.t - last.t > ALERT_BANNER_S || run.t < last.t) return null;
  // The plan step that sent it: the latest alert step to fire at or before it.
  const step = plan.actions
    .filter((a): a is Extract<ResponsePlan['actions'][number], { type: 'alert' }> => a.type === 'alert' && incidentAt + a.at <= last.t)
    .sort((a, b) => b.at - a.at)[0];
  const how = step?.channel === 'phone' ? 'Phone alert' : 'PA announcement';
  return (
    <div className="alert-banner">
      <strong>{how}</strong> reached {(last.dots.length * DOT_GROUP_SIZE).toLocaleString()} fans
      {step?.message && <span className="muted"> “{step.message}”</span>}
    </div>
  );
}

function Legend() {
  const rings: [string, number][] = [
    ['walking in', 3],
    ['waiting at a gate', 2],
    ['in their seat', 4],
    ['taking shelter', 5],
    ['leaving', 6],
  ];
  return (
    <div className="map-legend">
      <div className="legend-row">
        {rings.map(([text, state]) => (
          <span key={text}>
            <i className="ring" style={{ borderColor: rgbCss(STATE_RGB[state]!) }} />
            {text}
          </span>
        ))}
      </div>
      <div className="legend-row">
        <span>
          <i className="heat" /> coloured ground = how packed (key below)
        </span>
        <span>
          <i className="zone" /> incident zone
        </span>
        <span>
          <i className="cop" /> officer, click one
        </span>
        <span>
          <i className="route" /> officer route
        </span>
        <span>
          <i className="shut" /> closed
        </span>
        <span>
          <i className="alerted" /> got the alert
        </span>
        <span className="shirts" title={FAN_TYPES.map((t) => t.label).join(', ')}>
          {FAN_TYPES.slice(0, 5).map((t, i) => (
            <i key={t.id} style={{ background: `#${shirtColor(FAN_TYPES, i).toString(16).padStart(6, '0')}` }} />
          ))}
          shirt = type of fan
        </span>
      </div>
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
  const [mapId, setMapId] = useState<string | null>(MAP_PARAM ?? (AUTORUN ? 'default' : null));
  const [priority, setPriority] = useState<Priority>('clear');
  const [history, setHistory] = useState<{ runs: number; samples: HistorySample[] }>({ runs: 0, samples: [] });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [incidentIndex, setIncidentIndex] = useState(0);
  const [planStates, setPlanStates] = useState<PlanState[]>([]);
  const [plansDirty, setPlansDirty] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [savedComparison, setSavedComparison] = useState<string | null>(null);
  const [speed, setSpeed] = useState(20);
  const [scrub, setScrub] = useState<number | null>(null);
  const [picked, setPicked] = useState<{ run: number; dot: number } | null>(null);
  /** An officer clicked on the close-up. One inspector at a time: picking either clears the other. */
  const [pickedOfficer, setPickedOfficer] = useState<{ run: number; id: string } | null>(null);
  const [pickedVehicle, setPickedVehicle] = useState<{ run: number; vehicle: number } | null>(null);
  const [pickedCell, setPickedCell] = useState<Extract<MapPick, { type: 'cell' }> | null>(null);
  const [weatherId, setWeatherId] = useState(START_WEATHER);
  const [trafficOn, setTrafficOn] = useState(START_TRAFFIC);
  const [showVehicles, setShowVehicles] = useState(true);
  const [vehicleFocus, setVehicleFocus] = useState<VehicleKind | null>(null);
  const [selectedBand, setSelectedBand] = useState<number | null>(null);
  const [focusBox, setFocusBox] = useState<FocusBox | null>(null);
  /** The 3D close-up of one plan (the default) or all three maps side by side. */
  /** The 3D close-up of one plan (the default), a large 2D plan of one, or all three maps side by side. */
  const [view, setView] = useState<'close' | 'plan' | 'compare'>(
    params.get('view') === 'compare' ? 'compare' : params.get('view') === 'plan' ? 'plan' : 'close',
  );
  const [showFlow, setShowFlow] = useState(true);
  const [closeRun, setCloseRun] = useState(0);
  const [focusToken, setFocusToken] = useState(0);
  const [appliedNote, setAppliedNote] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [briefingBusy, setBriefingBusy] = useState(false);
  const [railTab, setRailTabState] = useState<RailTab>(() => {
    try {
      const saved = localStorage.getItem('gd-rail-tab');
      return RAIL_TABS.some((t) => t.id === saved) ? (saved as RailTab) : 'brief';
    } catch {
      return 'brief';
    }
  });
  const setRailTab = (tab: RailTab) => {
    setRailTabState(tab);
    try {
      localStorage.setItem('gd-rail-tab', tab);
    } catch {
      // private window: the rail opens on Brief next time
    }
  };

  useEffect(() => {
    if (!mapId) return;
    setLoaded(null);
    void (async () => {
      try {
        const map = await getMap(mapId);
        const defaults = await getDecisionDefaults();
        setLoaded({ map, defaults });
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [mapId]);

  // What "usual" means for this stadium: every past run's gate queues and stopped traffic.
  const loadHistory = (id: string) =>
    void fetch(`/api/history?map=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then(setHistory)
      .catch(() => {});
  useEffect(() => {
    if (loaded) loadHistory(loaded.map.id);
    // The whole app takes on the home team's colours; Ohio Stadium stays scarlet and grey.
    applyTheme(loaded?.map.theme);
  }, [loaded]);

  const incidents = useMemo<Incident[]>(() => (loaded ? incidentsFor(loaded.map) : []), [loaded]);
  const incident = incidents[incidentIndex];
  const zoneName = (incident?.placeId && loaded?.map.places.find((p) => p.id === incident.placeId)?.name) || 'the closed street';

  const restart = () => {
    setPlaying(false);
    setScrub(null);
    setBriefing(null);
    setPicked(null);
    setPickedOfficer(null);
    setPickedVehicle(null);
    setPickedCell(null);
    setSavedComparison(null);
    setPlansDirty(false);
    setGeneration((g) => g + 1);
  };

  const placeIndex = useMemo(() => (loaded ? makePlaceIndex(loaded.map) : null), [loaded]);
  const bands = useMemo(() => heatBands(DANGER), []);
  const traffic = trafficOn && !!loaded && hasRoads(loaded.map);

  // The sky and the traffic are part of the moment, not the plan: changing
  // either restarts all three runs on the same seed.
  const firstScenario = useRef(true);
  useEffect(() => {
    if (firstScenario.current) {
      firstScenario.current = false;
      return;
    }
    restart();
  }, [weatherId, trafficOn]);

  // Picking an incident loads its playbook as editable copies.
  useEffect(() => {
    if (!loaded || !incident) return;
    const plans = playbookFor(incident.kind, loaded.map).slice(0, 3);
    setPlanStates(plans.map((plan) => ({ plan, disabled: new Set<number>() })));
    restart();
  }, [loaded, incident]);

  const inits = useMemo<(RunInit | null)[]>(() => {
    if (!loaded || !incident || planStates.length === 0) return [null, null, null];
    const population = makePopulation(fanCount(loaded.map), SEED);
    const officers = makeOfficers(loaded.map, OFFICERS);
    const window = windowFor(incident);
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
        dangerDensity: DANGER,
        mapId: loaded.map.id,
        incident,
        plan: applyDisabled(state.plan, state.disabled),
        officers,
        traffic: traffic ? { vehicles: DEFAULT_VEHICLES, seed: SEED ^ 0x7a11c, emergencyResponse: true } : undefined,
        weather: weatherTimeline(weatherId),
      };
      return { config, map: loaded.map, population, defaults: loaded.defaults };
    });
    // speed is deliberately out of the dependency list: it is sent live below.
    // Plan edits wait for "Restart with my changes" rather than restarting mid-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, generation]);

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
  // "Best" is best for the priority the commander picked.
  const order = allDone ? rankByPriority(cards, priority) : null;
  void rankPlans;
  const rankOf = (i: number) => (order ? order.indexOf(i) : null);

  // Record this run's gate queues and stopped traffic by minute to kickoff, so
  // the next run of this stadium has a "usual" to compare against. Each run
  // only adds moments later than its last, so a rewind does not count twice.
  const recorded = useRef<{ generation: number; lastT: number[]; samples: { kind: string; subject: string; minute: number; value: number }[]; sent: boolean }>({
    generation: -1,
    lastT: [],
    samples: [],
    sent: false,
  });
  const streets = useMemo(() => (loaded ? streetIndex(loaded.map) : null), [loaded]);
  useEffect(() => {
    if (!loaded || !streets) return;
    const rec = recorded.current;
    if (rec.generation !== generation) recorded.current = { generation, lastT: [-Infinity, -Infinity, -Infinity], samples: [], sent: false };
    runs.forEach((run, i) => {
      const scene = run.scene.current;
      const frame = run.latest.current?.frame;
      if (!scene || !frame || scene.t <= recorded.current.lastT[i]! || scene.t % 60 !== 0) return;
      recorded.current.lastT[i] = scene.t;
      const minute = Math.round(scene.t / 60);
      for (const g of scene.gates) {
        const place = loaded.map.places[g.place];
        if (place) recorded.current.samples.push({ kind: 'gate_waiting', subject: place.id, minute, value: g.waiting });
      }
      stoppedPerStreet(loaded.map, streets, frame.vehicles).forEach((value, k) => {
        recorded.current.samples.push({ kind: 'street_stopped', subject: streets.streets[k]!.id, minute, value });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runA.tick, runB.tick, runC.tick, loaded, streets, generation]);
  useEffect(() => {
    const rec = recorded.current;
    if (!allDone || !loaded || rec.sent || rec.samples.length === 0) return;
    rec.sent = true;
    void fetch('/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapId: loaded.map.id, runId: `gen-${generation}-${Date.now()}`, samples: rec.samples }),
    }).then(() => loadHistory(loaded.map.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDone, loaded, generation]);

  // Start without a click when asked, once all three workers are ready. Only
  // once: `playing` is not a dependency, so this effect never sees a pause,
  // but without the ref the next ready flip after a restart would start play again.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!AUTORUN || autoStarted.current || !loaded) return;
    if (!runs.every((r) => r.ready)) return;
    autoStarted.current = true;
    setPlaying(true);
  }, [loaded, runA.ready, runB.ready, runC.ready]);

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

  const pickedRun = picked ? runs[picked.run] : undefined;

  // Ask the picked group's worker about them on every frame: the inspector
  // shows movement state (gate, admitted, edits) that a TickFrame does not carry.
  useEffect(() => {
    if (!picked || !pickedRun?.ready) return;
    pickedRun.send({ type: 'inspect', dot: picked.dot });
  }, [picked, pickedRun?.tick, pickedRun?.ready]);

  /**
   * An edit goes to all three workers for the same sim second, a little ahead
   * of whichever plan is furthest along, so none of them has passed it yet and
   * the three runs still differ only by their plans.
   */
  const applyEdit = (edit: EditRequest) => {
    if (!picked) return;
    const frame = runs[picked.run]?.latest.current?.frame;
    if (!frame) return;
    let dots = [picked.dot];
    if (edit.radiusM > 0 && frame.x[picked.dot]! >= 0) {
      const x = frame.x[picked.dot]!;
      const y = frame.y[picked.dot]!;
      dots = [];
      for (let i = 0; i < frame.x.length; i++) {
        if (frame.x[i]! < 0) continue;
        if (Math.hypot(frame.x[i]! - x, frame.y[i]! - y) <= edit.radiusM) dots.push(i);
      }
    }
    const at = Math.max(...runs.map((r) => r.t)) + FRAME_EVERY_S * 2;
    for (const run of runs) run.send({ type: 'edit', edit: { at, dots, fanType: edit.fanType, sendTo: edit.sendTo } });
    setSavedComparison(null);
    setAppliedNote(`Queued for ${dots.length.toLocaleString()} ${dots.length === 1 ? 'group' : 'groups'} at ${minutes(at)} from kickoff.`);
  };
  useEffect(() => setAppliedNote(null), [picked?.dot]);

  // Published for an unattended run: a browser with no debugger attached can
  // still be checked, because the server sees the saved comparison.
  useEffect(() => {
    (window as unknown as { gameday?: unknown }).gameday = {
      mapId: loaded?.map.id ?? null,
      incident: incident?.kind ?? null,
      weather: weatherId,
      traffic,
      allDone,
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
      savedComparison,
      briefing: briefing ? { canned: briefing.canned, model: briefing.model } : null,
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

  const t = Math.max(...runs.map((r) => r.t));
  const window_ = incident ? windowFor(incident) : { startAt: 0, endAt: 1 };
  const progress = Math.min(1, Math.max(0, (t - window_.startAt) / (window_.endAt - window_.startAt)));
  const status = incident ? incidentStatus(incident, t) : null;
  const started = runs.some((r) => r.frameCount > 1);
  const deciding = runs.reduce((sum, r) => sum + (r.deciding ?? 0), 0);
  const scrubT = scrub !== null ? runs.map((r) => r.frames.current?.[scrub]?.frame.t).find((x) => x !== undefined) : undefined;
  const kev = runs.reduce((sum, r) => sum + r.kevCount, 0);
  const totalDecisions = runs.reduce((sum, r) => sum + r.decisionCount, 0);
  const guessed = runs.reduce((sum, r) => sum + r.fallbackCount, 0);

  /** The frame on screen for a run: the scrubbed one, or the latest. */
  const shown = (run: RunHandle) => {
    const kept = run.frames.current ?? [];
    return scrub === null ? run.latest.current : (kept[Math.min(scrub, kept.length - 1)] ?? run.latest.current);
  };
  const ticks = runs.map((r) => r.tick).join(',');
  // People on their feet per run, which every colour and count below is built
  // from: seated fans are dense and safe, as in the scorecard's danger minutes.
  const standing = useMemo(
    () =>
      runs.map((run) => {
        const view = shown(run);
        return view?.density && loaded ? standingDensity(loaded.map, view.frame, view.density.peoplePerM2) : null;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ticks, scrub, loaded],
  );
  const totals = useMemo(
    () => standing.map((rho) => (rho ? bandTotals(rho, bands) : null)),
    [standing, bands],
  );
  const spots = useMemo<(Hotspot[] | null)[]>(() => {
    if (selectedBand === null || !loaded || !placeIndex) return [null, null, null];
    return standing.map((rho) => (rho ? hotspots(rho, loaded.map, bands[selectedBand]!, placeIndex, 4) : null));
  }, [standing, selectedBand, loaded, placeIndex, bands]);
  // The most congested places in each run, for the police list and the map pins.
  const police = useMemo<PoliceHotspot[][]>(() => {
    if (!loaded || !placeIndex) return [[], [], []];
    return runs.map((run, i) => policeHotspots(loaded.map, standing[i] ?? undefined, shown(run)?.frame.vehicles, placeIndex, DANGER, 6));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standing, loaded, placeIndex]);

  const vehicleCounts = useMemo(() => {
    const counts = new Map<VehicleKind, number>();
    const v = shown(runs[view === 'compare' ? 0 : closeRun]!)?.frame.vehicles;
    if (!v) return counts;
    for (let i = 0; i < v.kind.length; i++) {
      const state = VEHICLE_STATES[v.state[i]!];
      if (state === 'gone' || state === 'waiting') continue;
      const kind = VEHICLE_KINDS[v.kind[i]!]!;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticks, scrub, view, closeRun]);
  const vehicleInfo = (() => {
    if (!pickedVehicle) return null;
    const v = shown(runs[pickedVehicle.run]!)?.frame.vehicles;
    if (!v) return null;
    const i = pickedVehicle.vehicle;
    return {
      type: VEHICLE_TYPES[VEHICLE_KINDS[v.kind[i]!]!],
      state: VEHICLE_STATES[v.state[i]!]!,
      speed: v.speed[i]!,
      waited: v.waitedS[i]!,
    };
  })();
  const mapPicked: MapPick | null = pickedVehicle
    ? { type: 'vehicle', ...pickedVehicle }
    : picked
      ? { type: 'dot', ...picked }
      : pickedCell;
  const zoomTo = (h: Hotspot) => setFocusBox({ x0: h.x0, y0: h.y0, x1: h.x1, y1: h.y1, nonce: Date.now() });

  if (!mapId) {
    return (
      <StartScreen
        onPick={(id) => {
          const url = new URL(window.location.href);
          url.searchParams.set('map', id);
          window.history.replaceState(null, '', url);
          setMapId(id);
        }}
      />
    );
  }

  return (
    <>
      <header className="top">
        <div className="venue">
          <span className="venue-stripe" aria-hidden="true" />
          <div>
            <h1>{loaded ? loaded.map.name.replace(/ \+ 0\.5 mi$/, '') : 'Loading stadium'}</h1>
            <p>
              {loaded?.map.theme ? <span title={`Colours: ${loaded.map.theme.source}`}>{loaded.map.theme.team}</span> : 'Gameday Command'}
              <button
                className="link"
                onClick={() => {
                  setPlaying(false);
                  setLoaded(null);
                  setMapId(null);
                }}
              >
                Change stadium
              </button>
            </p>
          </div>
        </div>

        <nav className="situations" aria-label="Situation">
          {incidents.map((candidate, i) => (
            <button key={candidate.id} className={i === incidentIndex ? 'on' : undefined} onClick={() => setIncidentIndex(i)} aria-pressed={i === incidentIndex}>
              <strong>{INCIDENT_LABELS[candidate.kind]}</strong>
              <span>{clockText(candidate.at)}</span>
            </button>
          ))}
        </nav>

        <div className="clock">
          <div className="clock-read">
            <strong>{clockText(t)}</strong>
            {status && <span className={`status ${status.phase}`}>{status.text}</span>}
          </div>
          <span className="progress">
            <i style={{ width: `${progress * 100}%` }} />
            {incident && (
              <b
                className="incident-mark"
                style={{ left: `${((incident.at - window_.startAt) / (window_.endAt - window_.startAt)) * 100}%` }}
                title={`${INCIDENT_LABELS[incident.kind]} ${minutes(incident.at)} from kickoff`}
              />
            )}
          </span>
        </div>

      </header>

      {loadError && (
        <p className="banner error">
          Could not reach the server: {loadError}. Start it with <code>npm run serve</code>.
        </p>
      )}

      <div className="layout">
        <main>
          <div className="controls transport">
            <button className="go play" onClick={() => setPlaying((p) => !p)} disabled={!loaded || allDone}>
              {allDone ? 'Finished' : playing ? 'Pause' : started ? 'Resume' : 'Run all three plans'}
            </button>
            <span className="speed" role="group" aria-label="Simulation speed" title="How fast the simulated clock runs">
              {SPEEDS.map((s) => (
                <button key={s} className={speed === s ? 'on' : undefined} onClick={() => setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </span>
            <label className="field">
              <span>Weather</span>
              <select value={weatherId} onChange={(e) => setWeatherId(e.target.value)} title="The same for all three plans">
                {WEATHER_TIMELINES.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="toggle" title="Simulate vehicle traffic alongside the crowd">
              <input type="checkbox" checked={trafficOn} onChange={(e) => setTrafficOn(e.target.checked)} disabled={!loaded || !hasRoads(loaded.map)} />
              Vehicles
            </label>
            <button onClick={restart} disabled={!loaded}>
              Restart
            </button>
          </div>
          {loaded && (
            <>
              <div className={`canvas-wrap${view === 'close' ? ' close' : view === 'plan' ? ' plan' : ''}`}>
                {/* Only one of these is mounted at a time, so the page holds a
                    single WebGL context. ComparisonMaps draws all three runs in
                    one PixiJS Application for the same reason. */}
                {view !== 'close' ? (
                  <ComparisonMaps
                    key={view}
                    map={loaded.map}
                    runs={view === 'plan' ? [runs[closeRun]!] : runs}
                    showFlow={showFlow}
                    hotspots={view === 'plan' ? [police[closeRun] ?? []] : police}
                    scrubIndex={scrub}
                    dangerDensity={DANGER}
                    incidentCells={incident?.cells}
                    playing={playing}
                    selectedBand={selectedBand}
                    vehicleFocus={vehicleFocus}
                    showVehicles={showVehicles}
                    picked={view === 'plan' ? (mapPicked && mapPicked.run === closeRun ? { ...mapPicked, run: 0 } : null) : mapPicked}
                    focus={focusBox}
                    onPick={(raw) => {
                      // The 2D plan has one panel; its index 0 is the plan on show.
                      const pick = raw && view === 'plan' ? { ...raw, run: closeRun } : raw;
                      setPicked(pick?.type === 'dot' ? { run: pick.run, dot: pick.dot } : null);
                      setPickedVehicle(pick?.type === 'vehicle' ? { run: pick.run, vehicle: pick.vehicle } : null);
                      setPickedCell(pick?.type === 'cell' ? pick : null);
                      if (pick?.type === 'cell') setSelectedBand(pick.band);
                    }}
                  />
                ) : (
                  <CrowdView
                    map={loaded.map}
                    run={runs[closeRun]!}
                    types={FAN_TYPES}
                    scrubIndex={scrub}
                    dangerDensity={DANGER}
                    incidentCells={incident?.cells}
                    incidentLabel={incident ? `${INCIDENT_LABELS[incident.kind]} here` : undefined}
                    selected={picked?.run === closeRun ? picked.dot : null}
                    onPick={(dot) => {
                      setPickedOfficer(null);
                      setPickedVehicle(null);
                      setPicked(dot === null ? null : { run: closeRun, dot });
                    }}
                    selectedOfficer={pickedOfficer?.run === closeRun ? pickedOfficer.id : null}
                    onPickOfficer={(id) => {
                      setPicked(null);
                      setPickedVehicle(null);
                      setPickedOfficer({ run: closeRun, id });
                    }}
                    focusToken={focusToken}
                    showVehicles={showVehicles}
                    vehicleFocus={vehicleFocus}
                    selectedVehicle={pickedVehicle?.run === closeRun ? pickedVehicle.vehicle : null}
                    onPickVehicle={(vehicle) => {
                      setPicked(null);
                      setPickedOfficer(null);
                      setPickedVehicle({ run: closeRun, vehicle });
                    }}
                    selectedBand={selectedBand}
                    focusBox={focusBox}
                    showFlow={showFlow}
                    onShowFlow={setShowFlow}
                    hotspots={police[closeRun] ?? []}
                  />
                )}
                <div className="map-title">
                  {view !== 'compare' ? (
                    <>
                      <span className="label">{LABELS[closeRun]}</span> {planStates[closeRun]?.plan.name}
                    </>
                  ) : (
                    'Plans A, B and C side by side'
                  )}
                </div>
                <div className="view-toggle">
                  <button className={view === 'close' ? 'on' : undefined} onClick={() => setView('close')}>
                    3D
                  </button>
                  <button className={view === 'plan' ? 'on' : undefined} onClick={() => setView('plan')}>
                    2D plan
                  </button>
                  <button className={view === 'compare' ? 'on' : undefined} onClick={() => setView('compare')}>
                    All three
                  </button>
                </div>
                {deciding > 0 && (
                  <div className="deciding">Kev is deciding what {deciding.toLocaleString()} groups of fans do. The clock waits.</div>
                )}
                {scrub !== null && <div className="replaying">Replay</div>}
                {view === 'close' && <Legend />}
                {view === 'close' && runs[closeRun] && planStates[closeRun] && (
                  <AlertBanner run={runs[closeRun]!} plan={applyDisabled(planStates[closeRun]!.plan, planStates[closeRun]!.disabled)} incidentAt={incident?.at ?? 0} />
                )}
                {pickedOfficer && runs[pickedOfficer.run] && (
                  <OfficerPanel
                    map={loaded.map}
                    run={runs[pickedOfficer.run]!}
                    label={LABELS[pickedOfficer.run]!}
                    officerId={pickedOfficer.id}
                    onClose={() => setPickedOfficer(null)}
                  />
                )}
                {picked && pickedRun && (
                  <Inspector
                    map={loaded.map}
                    types={FAN_TYPES}
                    run={pickedRun}
                    label={LABELS[picked.run]}
                    dot={picked.dot}
                    scrubbing={scrub !== null}
                    appliedNote={appliedNote}
                    onApply={applyEdit}
                    onFocus={() => {
                      setCloseRun(picked.run);
                      setView('close');
                      setFocusToken((k) => k + 1);
                    }}
                    onClose={() => setPicked(null)}
                  />
                )}
                {pickedVehicle && vehicleInfo && (
                  <aside className="inspector vehicle-inspector">
                    <header>
                      <div>
                        <h3>{vehicleInfo.type.label}</h3>
                        <p className="muted">
                          Vehicle {pickedVehicle.vehicle}, plan {LABELS[pickedVehicle.run]}
                        </p>
                      </div>
                      <button className="small ghost" onClick={() => setPickedVehicle(null)} title="Close">
                        ✕
                      </button>
                    </header>
                    <section>
                      <VehicleIcon kind={vehicleInfo.type.kind} />
                      <dl className="detail">
                        <dt>doing</dt>
                        <dd className={vehicleInfo.state === 'stopped' ? 'warn' : undefined}>{vehicleInfo.state.replace(/_/g, ' ')}</dd>
                        <dt>speed</dt>
                        <dd>{Math.round(vehicleInfo.speed * 2.237)} mph</dd>
                        <dt>time stopped</dt>
                        <dd>{vehicleInfo.waited < 60 ? `${Math.round(vehicleInfo.waited)} s` : `${(vehicleInfo.waited / 60).toFixed(1)} min`}</dd>
                        <dt>size</dt>
                        <dd>
                          {vehicleInfo.type.lengthM.toFixed(1)} m × {vehicleInfo.type.widthM.toFixed(1)} m
                        </dd>
                        <dt>aboard</dt>
                        <dd>about {vehicleInfo.type.passengers}</dd>
                      </dl>
                    </section>
                  </aside>
                )}
                {pickedCell && placeIndex && !picked && !pickedVehicle && (
                  <aside className="inspector vehicle-inspector">
                    <header>
                      <span className="swatch" style={{ background: `rgb(${bands[pickedCell.band]!.rgb.join(',')})` }} />
                      <div>
                        <h3>{bands[pickedCell.band]!.label}</h3>
                        <p className="muted">
                          {bands[pickedCell.band]!.range}, plan {LABELS[pickedCell.run]}
                        </p>
                      </div>
                      <button className="small ghost" onClick={() => setPickedCell(null)} title="Close">
                        ✕
                      </button>
                    </header>
                    <section>
                      <p>
                        <strong>{pickedCell.density.toFixed(2)} people/m²</strong> near {placeIndex.describe(pickedCell.cell)}
                      </p>
                      <p className="muted">{bands[pickedCell.band]!.note} Every area this colour is highlighted, and the list below the map shows where.</p>
                    </section>
                  </aside>
                )}
                {!started && !picked && (
                  <div className="map-cta">
                    <p>{incident && pitchFor(incident, zoneName)}</p>
                    <button className="primary" onClick={() => setPlaying(true)} disabled={!runs.every((r) => r.ready)}>
                      Run all three plans
                    </button>
                    <span className="muted">Then scroll to zoom in and click any fan to see why they move.</span>
                  </div>
                )}
              </div>

              <div className="replay">
                <span className="replay-label">{scrub === null ? 'Live' : clockText(scrubT ?? t)}</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, maxFrames - 1)}
                  value={scrub ?? Math.max(0, maxFrames - 1)}
                  disabled={maxFrames < 2}
                  onChange={(e) => setScrub(Number(e.target.value))}
                  aria-label="Replay"
                />
                {scrub === null ? (
                  <span className="muted">Drag to look back</span>
                ) : (
                  <>
                    <button
                      className="small"
                      title="Rewind the simulations themselves to this moment and play on from here"
                      onClick={() => {
                        // Rewind the simulations themselves, not just the picture:
                        // each worker restores its nearest checkpoint and steps
                        // forward, so play resumes from this moment.
                        const at = scrub;
                        const frame = runs.map((r) => r.frames.current?.[at]).find((f) => f !== undefined);
                        if (!frame) return;
                        setPlaying(false);
                        setBriefing(null);
                        setSavedComparison(null);
                        for (const run of runs) run.seekTo(frame.frame.t);
                        setScrub(null);
                      }}
                    >
                      Play on from here
                    </button>
                    <button onClick={() => setScrub(null)} className="small">
                      Back to live
                    </button>
                  </>
                )}
              </div>

              <div className="band-bar">
                {traffic && (
                  <button className={`flow-key${showFlow ? ' on' : ''}`} onClick={() => setShowFlow((v) => !v)} title="Show or hide traffic flow on the roads">
                    <span className="legend-title">Traffic</span>
                    <span><i style={{ background: '#2ed573' }} /> Moving</span>
                    <span><i style={{ background: '#ffb020' }} /> Slow</span>
                    <span><i style={{ background: '#ff3040' }} /> Jammed</span>
                  </button>
                )}
                <span className="legend-title">How packed</span>
                {bands.map((band) => {
                  const total = totals.reduce((sum, t) => sum + (t?.[band.id]?.people ?? 0), 0) / 3;
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
                      {total > 0 && <b>{n(total)}</b>}
                    </button>
                  );
                })}
              </div>

              {selectedBand !== null && (
                <section className="block areas-panel">
                  <h2>
                    Where it is {bands[selectedBand]!.label.toLowerCase()}{' '}
                    <span className="muted-inline">{bands[selectedBand]!.range}, biggest areas per plan</span>
                    <button className="small" onClick={() => setSelectedBand(null)}>
                      Show all colours
                    </button>
                  </h2>
                  <div className="spots">
                    {spots.map((list, i) => (
                      <div key={i} className="spot-col">
                        <h3>
                          <span className="label">{LABELS[i]}</span> {totals[i] ? `${n(totals[i]![selectedBand]!.people)} people in ${n(totals[i]![selectedBand]!.cells * CELL_SIZE_M * CELL_SIZE_M)} m²` : ''}
                        </h3>
                        {!list && <p className="muted">no frame yet</p>}
                        {list && list.length === 0 && <p className="muted">none right now</p>}
                        {list?.map((h, k) => (
                          <button key={k} className="spot" onClick={() => zoomTo(h)}>
                            <span className="where">{h.where}</span>
                            <span className="nums">
                              {n(h.people)} people, {n(h.cells * CELL_SIZE_M * CELL_SIZE_M)} m², peak {h.peak.toFixed(1)}/m²
                            </span>
                            <span className="go">Show</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </section>
              )}

            </>
          )}
        </main>

        <aside className="side">
          <div className="rail-tabs" role="tablist" aria-label="Side panel">
            {RAIL_TABS.map((tab) => (
              <button key={tab.id} role="tab" aria-selected={railTab === tab.id} className={railTab === tab.id ? 'on' : undefined} onClick={() => setRailTab(tab.id)}>
                {tab.label}
                {tab.id === 'brief' && (police[closeRun]?.filter((h) => h.level === 'critical').length ?? 0) > 0 && (
                  <b className="tab-count">{police[closeRun]!.filter((h) => h.level === 'critical').length}</b>
                )}
                {tab.id === 'plans' && allDone && <b className="tab-dot" title="Results are in" />}
              </button>
            ))}
          </div>

          <div className="rail-body">
            {railTab === 'brief' && (
              <>
                {incident && <p className="pitch">{pitchFor(incident, zoneName)}</p>}
                {loaded && incident && planStates.length === 3 && (
                  <CommandPanel
                    map={loaded.map}
                    incident={incident}
                    run={runs[closeRun]!}
                    label={LABELS[closeRun]!}
                    labels={LABELS}
                    planNames={planStates.map((p) => p.plan.name)}
                    cards={cards}
                    allDone={allDone}
                    history={history}
                    priority={priority}
                    onPriority={setPriority}
                    onSuggest={(plans) => {
                      if (plans.length < 3) return;
                      setPlanStates(plans.slice(0, 3).map((plan) => ({ plan, disabled: new Set<number>() })));
                      restart();
                      setRailTab('plans');
                    }}
                  />
                )}
                <section className="block police">
                  <h2>
                    Most congested now <Info>Ranked by people standing packed at 3 or more per m² and by vehicles stopped or crawling. Seated fans are left out: a full section is dense but safe. This ranks places to look at; where to send officers stays your call.</Info>
                  </h2>
                  <div className="seg" role="group" aria-label="Plan">
                    {LABELS.map((l, i) => (
                      <button
                        key={l}
                        className={closeRun === i ? 'on' : undefined}
                        onClick={() => {
                          setCloseRun(i);
                          if (view === 'compare') setView('plan');
                        }}
                      >
                        Plan {l}
                        {(police[i]?.filter((h) => h.level === 'critical').length ?? 0) > 0 && <b className="crit-count">{police[i]!.filter((h) => h.level === 'critical').length}</b>}
                      </button>
                    ))}
                  </div>
                  {(police[closeRun] ?? []).length === 0 ? (
                    <p className="muted">{started ? 'Nothing congested at the moment.' : 'Run the plans to see where it gets congested.'}</p>
                  ) : (
                    <ol className="hotspots">
                      {(police[closeRun] ?? []).map((h) => (
                        <li key={h.rank} className={h.level}>
                          <button onClick={() => setFocusBox({ x0: h.x0, y0: h.y0, x1: h.x1, y1: h.y1, nonce: Date.now() })} title="Show on the map">
                            <span className="rank" style={{ background: HOTSPOT_COLOUR[h.level] }}>{h.rank}</span>
                            <span className="what">
                              <strong>{h.where}</strong>
                              <em>
                                {h.kind !== 'traffic' && `${n(h.crowdedPeople)} packed, peak ${h.peakDensity.toFixed(1)}/m²`}
                                {h.kind === 'both' && '; '}
                                {h.kind !== 'crowd' && `${h.stoppedVehicles} vehicles stopped${h.slowVehicles ? `, ${h.slowVehicles} slow` : ''}`}
                              </em>
                            </span>
                            <span className={`level ${h.level}`}>{h.level}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </>
            )}

            {railTab === 'plans' && (
              <>
                <section className="block verdict">
                  <h2>Verdict</h2>
                  {!allDone && <p className="muted">Appears when all three plans finish.</p>}
                  {allDone && incident && (
                    <>
                      <p className="verdict-line">
                        {verdictText(
                          LABELS,
                          planStates.map((p) => p.plan.name),
                          cards.filter((c): c is Scorecard => c !== null),
                          zoneName,
                        )}
                      </p>
                      {briefingBusy && <p className="muted">Writing the commander's briefing…</p>}
                      {briefing && (
                        <details className="briefing" open={!briefing.canned}>
                          <summary>{briefing.canned ? 'Full numbers for every plan' : "Commander's briefing"}</summary>
                          <p className="briefing-text">{briefing.text}</p>
                          <p className="muted">
                            {briefing.canned
                              ? 'Filled in from a template, because the on-device AI writer was not running.'
                              : 'Written by an on-device AI model. Every number in it is checked against the results.'}
                          </p>
                        </details>
                      )}
                    </>
                  )}
                </section>
                <section className="block">
                  <h2>
                    Three plans, same crowd <Info>Click a plan to show it on the map. The plans differ only in what you tell the crowd and staff to do.</Info>
                  </h2>
                  {loaded &&
                    incident &&
                    planStates.map((state, i) => (
                      <PlanCard
                        key={state.plan.id}
                        label={LABELS[i]}
                        state={state}
                        run={runs[i]!}
                        map={loaded.map}
                        incident={incident}
                        totalFans={fanCount(loaded.map)}
                        selected={view !== 'compare' && closeRun === i}
                        rank={rankOf(i)}
                        onSelect={() => {
                          setCloseRun(i);
                          setView('close');
                          if (picked) setPicked({ run: i, dot: picked.dot });
                        }}
                        onEdit={(plan, disabled) => {
                          setPlanStates((prev) => prev.map((p, j) => (j === i ? { plan, disabled } : p)));
                          setPlansDirty(true);
                        }}
                      />
                    ))}
                  {plansDirty && (
                    <button className="go wide" onClick={restart}>
                      Restart with my changes
                    </button>
                  )}
                </section>
              </>
            )}

            {railTab === 'gates' && loaded && runs[closeRun] && (
              <section className="block">
                <h2>
                  Gates for plan {LABELS[closeRun]} <Info>Every gate's door and flow for the plan on the map: people through it per minute in and out, the queue waiting, and how much of what it can pass it is passing. A closed gate passes nobody and turns its queue away to the next open gate.</Info>
                </h2>
                <GatesPanel map={loaded.map} run={runs[closeRun]!} label={LABELS[closeRun]!} />
              </section>
            )}

            {railTab === 'key' && (
              <>
                <section className="block">
                  <h2>How packed</h2>
                  <ul className="band-key">
                    {bands.map((band) => (
                      <li key={band.id}>
                        <i style={{ background: `rgb(${band.rgb.join(',')})` }} />
                        <span>
                          <strong>{band.label}</strong> {band.range}
                          <em>{band.note}</em>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="muted">Click a colour under the map to see every area at that level.</p>
                </section>
                {traffic && (
                  <section className="block">
                    <h2>Traffic on the roads</h2>
                    <ul className="band-key">
                      <li><i style={{ background: '#2ed573' }} /><span><strong>Moving</strong> 13 mph or faster</span></li>
                      <li><i style={{ background: '#ffb020' }} /><span><strong>Slow</strong> 3 to 13 mph</span></li>
                      <li><i style={{ background: '#ff3040' }} /><span><strong>Jammed</strong> stopped or crawling</span></li>
                    </ul>
                  </section>
                )}
                {traffic && (
                  <section className="block vehicles-panel">
                    <h2>
                      Vehicles
                      <label className="toggle">
                        <input type="checkbox" checked={showVehicles} onChange={(e) => setShowVehicles(e.target.checked)} /> Show on map
                      </label>
                    </h2>
                    <p className="muted">Real sizes, drawn to scale. Click a type to pick it out on the map.</p>
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
                            {type.lengthM.toFixed(1)} × {type.widthM.toFixed(1)} m, {type.passengers} aboard
                          </span>
                          <span className="vehicle-count">{(vehicleCounts.get(type.kind) ?? 0).toLocaleString()} on the map</span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}

            {railTab === 'about' && (
              <section className="block tech">
                <h2>How the AI and the numbers work</h2>
                <p>
                  {loaded ? fanCount(loaded.map).toLocaleString() : ''} fans are simulated as {loaded ? (fanCount(loaded.map) / DOT_GROUP_SIZE).toLocaleString() : ''}{' '}
                  groups of {DOT_GROUP_SIZE}, walking a real OpenStreetMap model of {loaded ? loaded.map.name.replace(/ \+ 0\.5 mi$/, '') : 'the stadium'} at 2 m
                  resolution. When a group has to choose (shelter or run to the car? follow the officer?), an AI model called Kev gives the odds of each
                  choice for that kind of fan.
                </p>
                <dl className="detail">
                  <dt>Fan choices made</dt>
                  <dd>{totalDecisions.toLocaleString()}</dd>
                  <dt>Answered by the AI</dt>
                  <dd>{(totalDecisions - guessed).toLocaleString()}{kev > 0 && <span className="muted"> ({kev.toLocaleString()} live)</span>}</dd>
                  <dt>Guessed from defaults</dt>
                  <dd className={guessed > 0 ? 'warn' : undefined}>{guessed.toLocaleString()}</dd>
                  {cards.some((c) => c) && (
                    <>
                      <dt>Crush-risk cell minutes</dt>
                      <dd>{cards.map((c, i) => `${LABELS[i]} ${c ? n(c.dangerMinutes) : '…'}`).join(', ')}</dd>
                      <dt>Most packed spot</dt>
                      <dd>{cards.map((c, i) => `${LABELS[i]} ${c ? c.peakDensity.toFixed(1) : '…'}/m²`).join(', ')}</dd>
                    </>
                  )}
                  {cards.some((c) => c?.vehicleDelayMin !== undefined) && (
                    <>
                      <dt>Vehicles that drove off</dt>
                      <dd>{cards.map((c, i) => `${LABELS[i]} ${c ? n(c.vehiclesOut ?? 0) : '…'}`).join(', ')}</dd>
                      <dt>Most stopped at once</dt>
                      <dd>{cards.map((c, i) => `${LABELS[i]} ${c ? n(c.peakVehiclesStopped ?? 0) : '…'}`).join(', ')}</dd>
                    </>
                  )}
                  <dt>Weather</dt>
                  <dd>{weatherTimeline(weatherId).label}, the same for all three</dd>
                  <dt>Random seed</dt>
                  <dd>{SEED}, the same for all three</dd>
                </dl>
                <p className="muted">
                  Fan behaviour, traffic and weather are an assumption, not a forecast. The tool shows the tradeoffs between plans. The commander makes the call.
                </p>
              </section>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
