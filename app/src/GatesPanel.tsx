import { useEffect, useMemo, useRef } from 'react';
import type { MapBundle } from '../../contracts.ts';
import type { RunHandle } from './useRun.ts';
import { classifyGates, type GateSample } from './gate-health.ts';
import './gate-health.css';

const n = (v: number) => Math.round(v).toLocaleString();

/**
 * Frames arrive every 15 sim seconds, so a few hundred samples is about an
 * hour of observed gate behaviour — enough to judge a 2 min hold and "never
 * admitted anyone" without growing with the run.
 */
const MAX_SAMPLES = 240;

/**
 * Every gate in one table: open or shut, people through it per minute in and
 * out, the queue waiting, and how much it can pass right now. Follows the plan
 * on the map, so a commander can watch a closed gate's queue move to the next.
 *
 * A gate that is open, has a queue and is passing nobody is invisible in that
 * table, so seized and dead gates are called out in red above it. That needs a
 * short history: `useRun` keeps none, so the panel accumulates its own samples
 * here. The limits of that are documented in `gate-health.ts`.
 */
export function GatesPanel({ map, run, label }: { map: MapBundle; run: RunHandle; label: string }) {
  const scene = run.scene.current;
  const gates = scene?.gates ?? [];
  const t = scene?.t ?? null;
  const history = useRef<GateSample[]>([]);

  useEffect(() => {
    if (t === null) return;
    const samples = history.current;
    const last = samples[samples.length - 1];
    // A rewind moves t backwards: samples from the old timeline no longer
    // describe this run, so start observing again from here.
    if (last && t < last.t) samples.length = 0;
    if (last && last.t === t) return;
    samples.push({ t, gates: [...gates] });
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  }, [t, gates]);

  const health = useMemo(
    () => (t === null ? [] : classifyGates(history.current, { t, gates })),
    [t, gates],
  );

  const gateName = (place: number) =>
    (map.places[place]?.name ?? '').replace(/\s*\(.*\)/, '') || `Gate ${place}`;

  const alerts = health
    .filter((h) => h.health === 'seized' || h.health === 'unused')
    .sort((a, b) => (a.health === b.health ? a.place - b.place : a.health === 'seized' ? -1 : 1));

  const totalIn = gates.reduce((s, g) => s + g.inPerMin, 0);
  const totalOut = gates.reduce((s, g) => s + g.outPerMin, 0);
  const waiting = gates.reduce((s, g) => s + g.waiting, 0);
  const open = gates.filter((g) => g.open).length;

  return (
    <div className="gates">
      {alerts.length > 0 && (
        <div className="gate-alerts">
          {alerts.map((h) => (
            <div key={h.place} className={`alert ${h.health}`}>
              <strong>{h.health === 'seized' ? '⛔ Seized' : '⚠ Unused'}</strong> {gateName(h.place)} · {h.reason}
            </div>
          ))}
        </div>
      )}
      <p className="muted">
        Plan {label} · <strong className="ok">{open} open</strong> · <strong className={open < gates.length ? 'bad' : undefined}>{gates.length - open} closed</strong> ·{' '}
        {n(totalIn)} in/min · {n(totalOut)} out/min · {n(waiting)} waiting
      </p>
      {gates.length === 0 ? (
        <p className="muted">Starts with the run.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Gate</th>
              <th>Door</th>
              <th title="People through the turnstile in the last minute">In/min</th>
              <th title="People leaving through it in the last minute">Out/min</th>
              <th title="People queueing for it, not yet through">Waiting</th>
              <th title="How much of what it can pass per minute it is passing">Use</th>
            </tr>
          </thead>
          <tbody>
            {gates.map((g) => {
              const name = gateName(g.place);
              const use = g.capacityPerMin > 0 ? Math.min(1, g.inPerMin / g.capacityPerMin) : 0;
              return (
                <tr key={g.place} className={g.open ? undefined : 'shut'}>
                  <td>
                    {name}
                    {g.officers > 0 && <span className="cops" title={`${g.officers} officers on station`}> 🚓{g.officers}</span>}
                  </td>
                  <td>
                    <span className={`door ${g.open ? 'open' : 'closed'}`}>{g.open ? 'Open' : 'Closed'}</span>
                  </td>
                  <td>{n(g.inPerMin)}</td>
                  <td>{n(g.outPerMin)}</td>
                  <td className={g.waiting > 1000 ? 'bad' : undefined}>{n(g.waiting)}</td>
                  <td>
                    <span className="bar" title={`${n(g.inPerMin)} of ${n(g.capacityPerMin)} per minute`}>
                      <i style={{ width: `${Math.round(use * 100)}%` }} />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
