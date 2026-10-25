import { useEffect, useMemo, useState } from 'react';
import type { Incident, MapBundle, ResponsePlan, Scorecard } from '../../contracts.ts';
import type { GateStat } from '../../engine/src/edits.ts';
import {
  briefLine,
  PRIORITIES,
  rankByPriority,
  readings,
  stoppedPerStreet,
  streetIndex,
  suggestPlans,
  levelOf,
  noneAchieve,
  GATE_LEVELS,
  STREET_LEVELS,
  usualAt,
  type HistorySample,
  type Priority,
  type Reading,
} from './command.ts';
import { parseConditions, type Conditions } from './conditions.ts';
import type { RunHandle } from './useRun.ts';

const LEVEL_TEXT: Record<Reading['level'], string> = { low: 'Low', medium: 'Medium', high: 'High' };

export interface CommandPanelProps {
  map: MapBundle;
  incident: Incident;
  run: RunHandle;
  label: string;
  history: { runs: number; samples: HistorySample[] };
  onSuggest: (plans: ResponsePlan[]) => void;
}

export interface RankingProps {
  map: MapBundle;
  incident: Incident;
  labels: readonly string[];
  planNames: string[];
  cards: (Scorecard | null)[];
  allDone: boolean;
  priority: Priority;
  onPriority: (p: Priority) => void;
}

/**
 * The commander's brief, on the Brief tab:
 *   1. Right now: every gate and street, low / medium / high, from the
 *      simulation or from real conditions the commander loads.
 *   2. Suggested plans built from those conditions, loaded into A, B and C.
 * Which plan is best, and what the commander thinks of it, is `Ranking` on
 * the Plans tab, next to the verdict.
 */
export function CommandPanel(props: CommandPanelProps) {
  const { map, incident, run, label, history, onSuggest } = props;
  const index = useMemo(() => streetIndex(map), [map]);
  const [conditions, setConditions] = useState<Conditions | null>(null);
  const [feedUrl, setFeedUrl] = useState('');
  const [feedNote, setFeedNote] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const minute = Math.round(run.t / 60);
  // Real conditions are compared with history only at the minute they were taken.
  const feedMinute = conditions?.minuteToKickoff ?? null;
  const now: Reading[] = useMemo(() => {
    if (conditions) {
      // Real conditions: only what the feed reported. Nothing is filled in.
      const out: Reading[] = [];
      for (const [id, value] of conditions.gates) {
        const place = map.places.find((p) => p.id === id)!;
        const usual = feedMinute === null ? null : usualAt(history.samples, 'gate_waiting', id, feedMinute);
        out.push({ id, name: place.name, kind: 'gate', value, usual, level: levelOf(value, usual, GATE_LEVELS) });
      }
      for (const [id, value] of conditions.streets) {
        const street = map.closables.find((c) => c.id === id)!;
        const usual = feedMinute === null ? null : usualAt(history.samples, 'street_stopped', id, feedMinute);
        out.push({ id, name: street.name, kind: 'street', value, usual, level: levelOf(value, usual, STREET_LEVELS) });
      }
      const rank = { high: 2, medium: 1, low: 0 };
      return out.sort((a, b) => rank[b.level] - rank[a.level] || b.value - a.value);
    }
    const gates: GateStat[] = run.scene.current?.gates ?? [];
    const stopped = stoppedPerStreet(map, index, run.latest.current?.frame.vehicles);
    return readings(map, gates, stopped, index, history.samples, minute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conditions, run.tick, map, index, history, minute]);

  const busy = now.filter((r) => r.level !== 'low');
  const shown = showAll ? now : busy.slice(0, 6);

  const loadText = (text: string, source: string) => {
    try {
      const parsed = parseConditions(text, map, source);
      if (parsed.gates.size + parsed.streets.size === 0) {
        setFeedNote(`Nothing in it matched this map's gates or streets${parsed.unmatched.length ? ` (e.g. ${parsed.unmatched[0]})` : ''}.`);
        return;
      }
      setConditions(parsed);
      setFeedNote(parsed.unmatched.length ? `${parsed.unmatched.length} entries did not match this map and were left out.` : null);
    } catch (error) {
      setFeedNote(`Could not read it: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const fetchFeed = async () => {
    setFeedNote('Fetching…');
    const res = await fetch('/api/conditions/fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: feedUrl }) });
    const body = (await res.json()) as { text?: string; fetchedAt?: string; error?: string };
    if (!res.ok || !body.text) {
      setFeedNote(body.error ?? `Feed failed (${res.status}).`);
      return;
    }
    loadText(body.text, new URL(feedUrl).host);
  };

  return (
    <section className="block command">
      <h2>Right now</h2>

      <div className="brief-source">
        {conditions ? (
          <>
            <span className="src live">Real conditions</span> {conditions.source}
            {conditions.at && <em>, as of {new Date(conditions.at).toLocaleTimeString()}</em>}
            {feedMinute === null ? <em>. No time to kickoff given, so fixed thresholds.</em> : <em>, {Math.abs(feedMinute)} min {feedMinute < 0 ? 'before' : 'after'} kickoff</em>}
            <button className="small ghost" onClick={() => setConditions(null)}>
              Back to simulation
            </button>
          </>
        ) : (
          <>
            <span className="src sim">Simulation</span> Plan {label}
            {history.runs > 0 ? <em>, compared with {history.runs} past runs</em> : <em>. No history yet, so fixed thresholds.</em>}
          </>
        )}
      </div>

      {busy.length === 0 && !showAll ? (
        <p className="muted">{run.ready && run.frameCount > 1 ? 'All gates and streets are at low levels.' : 'Starts with the run, or load real conditions below.'}</p>
      ) : (
        <ul className="brief">
          {shown.map((r) => (
            <li key={`${r.kind}-${r.id}`} className={r.level}>
              <span className={`lvl ${r.level}`}>{LEVEL_TEXT[r.level]}</span>
              <span>{briefLine(r)}</span>
            </li>
          ))}
        </ul>
      )}
      {now.length > 0 && (
        <button className="link" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show only busy places' : `Show all ${now.length} gates and streets`}
        </button>
      )}

      <details className="feed">
        <summary>Load real conditions (gate scans, traffic)</summary>
        <p className="muted">JSON or CSV with gate queues and stopped vehicles by name. Only what the feed reports is shown; nothing is filled in.</p>
        <label className="file">
          <input
            aria-label="Load a conditions file"
            type="file"
            accept=".json,.csv,.txt"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then((t) => loadText(t, file.name));
            }}
          />
        </label>
        <div className="feed-url">
          <input type="url" placeholder="Feed URL" value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} />
          <button className="small" disabled={!/^https?:\/\//.test(feedUrl)} onClick={() => void fetchFeed()}>
            Fetch
          </button>
        </div>
        {feedNote && <p className="muted">{feedNote}</p>}
      </details>

      <div className="suggest">
        <button
          className="go wide"
          disabled={now.length === 0}
          onClick={() => onSuggest(suggestPlans(map, incident.kind, now, incident.placeId))}
          title="Build three plans from the conditions above: redirect, close and reroute, officers and a street closure"
        >
          Build three plans from this
        </button>
        <p className="muted">Fills A, B and C with a redirect, a closure and an officer plan. Edit them, then run.</p>
      </div>

    </section>
  );
}

/** Which plan is best for the priority the commander picks, and what they think of it. Never an order: "your call". */
export function Ranking({ map, incident, labels, planNames, cards, allDone, priority, onPriority }: RankingProps) {
  const order = allDone ? rankByPriority(cards, priority) : null;
  const best = order ? order[0]! : null;
  const why = PRIORITIES.find((p) => p.id === priority)!;
  return (
    <section className="block ranking">
      <label className="priority">
        What matters most?
        <select value={priority} onChange={(e) => onPriority(e.target.value as Priority)}>
          {PRIORITIES.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {best !== null && cards[best] && noneAchieve(cards, priority) ? (
        <p className="best-line">
          <strong>No plan managed this:</strong> {cards.map((c, i) => `${labels[i]} ${c ? why.why(c) : '…'}`).join(', ')}. Ranked by crush risk instead:
          Plan {labels[best]} ({planNames[best]}) comes first. Your call.
        </p>
      ) : best !== null && cards[best] ? (
        <p className="best-line">
          <strong>Best for “{why.label.toLowerCase()}”: Plan {labels[best]}</strong> ({planNames[best]}), {why.why(cards[best]!)}.
          <span className="muted"> Then {order!.slice(1).map((i) => `${labels[i]} (${cards[i] ? why.why(cards[i]!) : '…'})`).join(', ')}. Your call.</span>
        </p>
      ) : (
        <p className="muted">The ranking appears when all three plans finish.</p>
      )}

      {allDone && <Feedback mapId={map.id} incident={incident.kind} labels={labels} best={best !== null ? labels[best]! : null} priority={priority} />}
    </section>
  );
}

function Feedback({ mapId, incident, labels, best, priority }: { mapId: string; incident: string; labels: readonly string[]; best: string | null; priority: Priority }) {
  const [pick, setPick] = useState(best ?? 'A');
  const [agree, setAgree] = useState<boolean | null>(null);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const [log, setLog] = useState<{ pick: string; agree: boolean | null; note: string; at: number }[]>([]);

  const load = () =>
    void fetch(`/api/feedback?map=${encodeURIComponent(mapId)}`)
      .then((r) => r.json())
      .then(setLog)
      .catch(() => {});
  useEffect(load, [mapId]);

  return (
    <div className="feedback">
      <h3>What do you think?</h3>
      {sent ? (
        <p className="ok-note">Thanks, noted. It is kept with the run for the after-action review.</p>
      ) : (
        <>
          <label>
            The plan you would go with
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              {labels.map((l) => (
                <option key={l} value={l}>
                  Plan {l}
                </option>
              ))}
              <option value="none">None of these</option>
            </select>
          </label>
          <div className="agree">
            Do you agree with the ranking?
            <button className={`small${agree === true ? ' on' : ''}`} onClick={() => setAgree(true)}>
              Yes
            </button>
            <button className={`small${agree === false ? ' on' : ''}`} onClick={() => setAgree(false)}>
              No
            </button>
          </div>
          <textarea placeholder="What would you do differently? (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          <button
            className="small"
            onClick={() =>
              void fetch('/api/feedback', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ mapId, incident, pick, agree, note, best, priority }),
              }).then(() => {
                setSent(true);
                load();
              })
            }
          >
            Send
          </button>
        </>
      )}
      {log.length > 0 && (
        <p className="muted">
          {log.length} {log.length === 1 ? 'response' : 'responses'} so far. Last: plan {log[0]!.pick}
          {log[0]!.agree === false ? ', disagreed with the ranking' : log[0]!.agree ? ', agreed' : ''}
          {log[0]!.note ? `, “${log[0]!.note}”` : ''}
        </p>
      )}
    </div>
  );
}
