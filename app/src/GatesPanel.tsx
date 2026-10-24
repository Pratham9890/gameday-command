import { useMemo } from 'react';
import type { MapBundle } from '../../contracts.ts';
import type { RunHandle } from './useRun.ts';

const n = (v: number) => Math.round(v).toLocaleString();

/**
 * Every gate in one table: open or shut, people through it per minute in and
 * out, the queue waiting, and how much it can pass right now. Follows the plan
 * on the map, so a commander can watch a closed gate's queue move to the next.
 */
export function GatesPanel({ map, run, label, onToggle, disabled = false }: {
  map: MapBundle;
  run: RunHandle;
  label: string;
  onToggle?: (closableId: string, closed: boolean) => void;
  disabled?: boolean;
}) {
  const doors = useMemo(() => map.places.map((place) => place.kind === 'gate'
    ? map.closables.find((c) => c.cells.some((cell) => place.cells.includes(cell)))
    : undefined), [map]);
  const gates = run.scene.current?.gates ?? [];
  const totalIn = gates.reduce((s, g) => s + g.inPerMin, 0);
  const totalOut = gates.reduce((s, g) => s + g.outPerMin, 0);
  const waiting = gates.reduce((s, g) => s + g.waiting, 0);
  const open = gates.filter((g) => g.open).length;

  return (
    <div className="gates">
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
              const name = (map.places[g.place]?.name ?? '').replace(/\s*\(.*\)/, '');
              const use = g.capacityPerMin > 0 ? Math.min(1, g.inPerMin / g.capacityPerMin) : 0;
              return (
                <tr key={g.place} className={g.open ? undefined : 'shut'}>
                  <td>
                    {name}
                    {g.officers > 0 && <span className="cops" title={`${g.officers} officers on station`}> 🚓{g.officers}</span>}
                  </td>
                  <td>
                    <span className={`door ${g.open ? 'open' : 'closed'}`}>{g.open ? 'Open' : 'Closed'}</span>
                    {onToggle && doors[g.place] && (
                      <button className="small ghost gate-order" disabled={disabled} onClick={() => onToggle(doors[g.place]!.id, g.open)}>
                        {g.open ? 'Close' : 'Open'}
                      </button>
                    )}
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
