import { useEffect, useMemo, useState } from 'react';
import type { Briefing, DecisionDefaults, Incident, MapBundle, ResponsePlan, Scorecard, SimConfig } from '../../contracts.ts';
import { DEFAULT_DANGER_DENSITY, DOT_GROUP_SIZE, FRAME_EVERY_S } from '../../contracts.ts';
import { makePopulation } from '../../brain/src/fan-types.ts';
import { makeOfficers } from '../../world/src/officers.ts';
import { INCIDENT_LABELS, incidentsFor, windowFor } from '../../world/src/incidents.ts';
import { playbookFor } from '../../world/src/playbook.ts';
import { getBriefing, getDecisionDefaults, getMap, saveComparison } from './api.ts';
import { ComparisonMaps } from './ComparisonMaps.tsx';
import { applyDisabled, PlanEditor } from './PlanEditor.tsx';
import { useRun, type RunHandle, type RunInit } from './useRun.ts';

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
const STADIUM_FANS = 100_000;
const TEST_FANS = 1200;
const OFFICERS = 24;

const fanCount = (map: MapBundle) => (map.width > 200 ? STADIUM_FANS : TEST_FANS);
const minutes = (seconds: number) => `${seconds < 0 ? '−' : '+'}${Math.abs(Math.round(seconds / 60))} min`;

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
  const [picked, setPicked] = useState<{ run: number; dot: number } | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [briefingBusy, setBriefingBusy] = useState(false);

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

  // Picking an incident loads its playbook as editable copies.
  useEffect(() => {
    if (!loaded || !incident) return;
    const plans = playbookFor(incident.kind, loaded.map).slice(0, 3);
    setPlanStates(plans.map((plan) => ({ plan, disabled: new Set<number>() })));
    setBriefing(null);
    setScrub(null);
    setPicked(null);
    setPlaying(false);
    setGeneration((g) => g + 1);
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
        dangerDensity: DEFAULT_DANGER_DENSITY,
        mapId: loaded.map.id,
        incident,
        plan: applyDisabled(state.plan, state.disabled),
        officers,
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

  const pickedRecord = picked ? runs[picked.run]?.decisionsByDot.current?.get(picked.dot) : undefined;

  // Published for an unattended run: a browser with no debugger attached can
  // still be checked, because the server sees the saved comparison.
  useEffect(() => {
    (window as unknown as { gameday?: unknown }).gameday = {
      mapId: loaded?.map.id ?? null,
      incident: incident?.kind ?? null,
      allDone,
      savedComparison,
      briefing: briefing ? { canned: briefing.canned, model: briefing.model } : null,
      runs: runs.map((r, i) => ({
        label: LABELS[i],
        ready: r.ready,
        scorecard: r.scorecard,
        snapshotAt: r.snapshotAt,
        snapshotDots: r.snapshotDots,
        fallbacksSoFar: r.fallbackCount,
      })),
    };
  });

  return (
    <>
      <header className="top">
        <h1>Gameday Command</h1>
        <span className="sub">
          {loaded
            ? `${loaded.map.name} · ${fanCount(loaded.map).toLocaleString()} fans as ${(fanCount(loaded.map) / DOT_GROUP_SIZE).toLocaleString()} dots · seed ${SEED}`
            : 'loading map…'}
        </span>
        <div className="controls">
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
              setPlaying(false);
              setScrub(null);
              setBriefing(null);
              setPicked(null);
              setGeneration((g) => g + 1);
            }}
            disabled={!loaded}
          >
            Reset
          </button>
        </div>
      </header>

      <p className="assumption">
        Fan behavior in this tool is an <strong>assumption, not a forecast</strong>. It shows the tradeoffs between plans
        on the same crowd and the same seed. The commander makes the call.
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
                setPlaying(false);
                setBriefing(null);
                setScrub(null);
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
                {/* One PixiJS Application for all three runs: three WebGL
                    contexts meant paying Pixi's GPU probe three times. */}
                <ComparisonMaps
                  map={loaded.map}
                  runs={runs}
                  scrubIndex={scrub}
                  dangerDensity={DEFAULT_DANGER_DENSITY}
                  incidentCells={incident?.cells}
                  onPickDot={(run, dot) => setPicked({ run, dot })}
                />
                {runs.some((r) => r.deciding !== null) && (
                  <div className="deciding">
                    deciding… {runs.reduce((n, r) => n + (r.deciding ?? 0), 0)} groups
                  </div>
                )}
                {scrub !== null && <div className="replaying">replay</div>}
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
                <button onClick={() => setScrub(null)} className="small">
                  Back to live
                </button>
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
              <h2>Why this group moved</h2>
              {!picked && <p className="muted">Click a dot on any map.</p>}
              {picked && !pickedRecord && (
                <p className="muted">
                  Dot {picked.dot} in run {LABELS[picked.run]} has not hit a decision yet — it is still walking its
                  flow field.
                </p>
              )}
              {picked && pickedRecord && (
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
            </section>
          </div>
        </main>
      </div>

      <div className="legend">
        <span>
          <i style={{ background: '#9ece6a' }} /> walking
        </span>
        <span>
          <i style={{ background: '#e0af68' }} /> queued
        </span>
        <span>
          <i style={{ background: '#f7768e' }} /> sheltering
        </span>
        <span>
          <i style={{ background: '#7dcfff' }} /> seated
        </span>
        <span>
          <i style={{ background: '#c0caf5' }} /> leaving
        </span>
        <span>
          <i style={{ background: '#58a6ff' }} /> officer
        </span>
        <span>
          <i style={{ background: 'linear-gradient(90deg,#5ab45a,#ff4d28)' }} /> density, red at{' '}
          {DEFAULT_DANGER_DENSITY}/m²
        </span>
      </div>
    </>
  );
}
