import { useEffect, useMemo, useState } from 'react';
import type { DecisionDefaults, Incident, MapBundle, ResponsePlan, SimConfig } from '../../contracts.ts';
import { DEFAULT_DANGER_DENSITY, DOT_GROUP_SIZE } from '../../contracts.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { gateSurge, northGate } from '../../world/src/incidents.ts';
import { getDecisionDefaults, getMap, getPlans } from './api.ts';
import { MapView } from './MapView.tsx';
import { useRun, type RunInit } from './useRun.ts';

/** One seed for every plan in a comparison: the whole point is the same crowd. */
const SEED = 20251023;
const LABELS = ['A', 'B', 'C'] as const;
/** The server serves the stadium map when it has been fetched, else the test map. */
const MAP_ID = 'default';
const STADIUM_FANS = 100_000;
const TEST_FANS = 1200;
/** Kickoff minus 60 minutes, per the demo script, through to kickoff plus 15. */
const START_AT = -3600;
const END_AT = 900;

const fanCount = (map: MapBundle) => (map.width > 200 ? STADIUM_FANS : TEST_FANS);

interface Loaded {
  map: MapBundle;
  defaults: DecisionDefaults;
  plans: ResponsePlan[];
  incident: Incident;
}

function RunPanel({ init, map, playing }: { init: RunInit | null; map: MapBundle; playing: boolean }) {
  const run = useRun(init);
  const { send, ready } = run;

  useEffect(() => {
    if (!ready) return;
    send({ type: playing ? 'play' : 'pause' });
  }, [ready, playing, send]);

  const fallbacks = run.decisions.filter((d) => d.source === 'default').length;
  const newest = run.decisions[0];
  const card = run.scorecard;

  return (
    <section className="run">
      <h2>
        <span className="label">{init?.config.label ?? '—'}</span>
        <span className="plan-name">{init?.config.plan.name ?? 'loading'}</span>
      </h2>
      <div className="canvas-wrap">
        <MapView map={map} latest={run.latest} tick={run.tick} dangerDensity={init?.config.dangerDensity ?? DEFAULT_DANGER_DENSITY} />
        {run.deciding !== null && <div className="deciding">deciding… {run.deciding} groups</div>}
      </div>
      <div className="scorecard">
        <dl>
          <dt>sim clock</dt>
          <dd>{Math.round(run.t / 60)} min to kickoff</dd>
          <dt>decisions seen</dt>
          <dd>{run.decisions.length}</dd>
          <dt>fallbacks</dt>
          <dd>{fallbacks}</dd>
          {card ? (
            <>
              <dt>time to clear</dt>
              <dd>{card.timeToClearMin === null ? 'not cleared' : `${Math.round(card.timeToClearMin)} min`}</dd>
              <dt>peak density</dt>
              <dd>{card.peakDensity.toFixed(1)} /m²</dd>
              <dt>danger minutes</dt>
              <dd>{Math.round(card.dangerMinutes)}</dd>
              <dt>first officer</dt>
              <dd>{card.firstOfficerMin === null ? 'none' : `${Math.round(card.firstOfficerMin)} min`}</dd>
              <dt>officer minutes</dt>
              <dd>{Math.round(card.officerMinutesUsed)}</dd>
              <dt>fans not reached</dt>
              <dd>{card.fansNotReached}</dd>
            </>
          ) : (
            <>
              <dt className="pending">scorecard</dt>
              <dd className="pending">at end of run</dd>
            </>
          )}
        </dl>
        {newest && (
          <p style={{ color: 'var(--dim)', marginBottom: 0 }}>
            Why this group moved: {newest.fanTypeId} hit <strong>{newest.situation}</strong> and chose{' '}
            <strong>{newest.picked}</strong> ({newest.source}).
          </p>
        )}
        {run.error && <p style={{ color: 'var(--scarlet)' }}>{run.error}</p>}
      </div>
    </section>
  );
}

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const map = await getMap(MAP_ID);
        const [defaults, plans] = await Promise.all([getDecisionDefaults(), getPlans('gate_surge')]);
        setLoaded({ map, defaults, plans, incident: gateSurge(map, 0) });
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, []);

  const inits = useMemo<(RunInit | null)[]>(() => {
    if (!loaded) return [null, null, null];
    const fans = loaded.map.width > 200 ? STADIUM_FANS : TEST_FANS;
    const population = makePopulation(fans, SEED);
    const officers = makeOfficers(loaded.map, 24);
    return LABELS.map((label, i) => {
      const plan = loaded.plans[i];
      if (!plan) return null;
      const config: SimConfig = {
        runId: `run-${label}`,
        label,
        seed: SEED,
        startAt: START_AT,
        endAt: END_AT,
        speed: 10,
        dangerDensity: DEFAULT_DANGER_DENSITY,
        mapId: loaded.map.id,
        incident: loaded.incident,
        plan,
        officers,
      };
      return { config, map: loaded.map, population, defaults: loaded.defaults };
    });
  }, [loaded]);

  return (
    <>
      <header className="top">
        <h1>Gameday Command</h1>
        <span className="sub">
          {loaded ? `${loaded.map.name} · ${fanCount(loaded.map).toLocaleString()} fans · ${(fanCount(loaded.map) / DOT_GROUP_SIZE).toLocaleString()} dots · seed ${SEED}` : 'loading map…'}
        </span>
        <span className="sub">
          · {loaded ? `gate surge at ${northGate(loaded.map)?.name ?? 'the north gate'}, kickoff` : 'gate surge'}
        </span>
        <button onClick={() => setPlaying((p) => !p)} disabled={!loaded} style={{ marginLeft: 'auto' }}>
          {playing ? 'Pause all three' : 'Run all three'}
        </button>
      </header>
      <p className="assumption">
        Fan behavior in this tool is an <strong>assumption, not a forecast</strong>. It shows tradeoffs between plans. The
        commander makes the call.
      </p>
      {loadError && <p className="assumption">Could not reach the server: {loadError}. Start it with <code>npm run serve</code>.</p>}
      <div className="runs">
        {loaded && inits.map((init, i) => <RunPanel key={LABELS[i]} init={init} map={loaded.map} playing={playing} />)}
      </div>
      <div className="legend">
        <span><i style={{ background: '#9ece6a' }} /> walking</span>
        <span><i style={{ background: '#e0af68' }} /> queued</span>
        <span><i style={{ background: '#f7768e' }} /> sheltering</span>
        <span><i style={{ background: '#c0caf5' }} /> leaving</span>
        <span><i style={{ background: '#58a6ff' }} /> officer</span>
        <span><i style={{ background: 'linear-gradient(90deg,#5ab45a,#ff4d28)' }} /> density, red at {DEFAULT_DANGER_DENSITY}/m²</span>
      </div>
    </>
  );
}
