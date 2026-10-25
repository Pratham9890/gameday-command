import { useRef } from 'react';
import type { MapBundle } from '../../contracts.ts';
import type { RunHandle } from './useRun.ts';
import { lotRows, rosterRows, zoneRows, type ZoneSample } from './boards.ts';
import { clockText } from './story.ts';

const n = (v: number) => Math.round(v).toLocaleString();

/** Zones ranked by people, with the 15-minute trend and time to 4 p/m². */
export function ZoneTable({ map, run }: { map: MapBundle; run: RunHandle }) {
  const density = run.latest.current?.density;
  const t = run.latest.current?.frame.t ?? 0;
  const history = useRef<{ t: number; rows: Record<string, ZoneSample> }>({ t, rows: {} });
  const rows = zoneRows(map, density, history.current.rows);
  if (t - history.current.t >= 15 * 60 || t < history.current.t) {
    history.current = { t, rows: Object.fromEntries(rows.map((r) => [r.id, { people: r.people, peak: r.peak }])) };
  }
  return (
    <section className="panel">
      <h2>Zones <span className="muted">· people, 15-min trend, time to 4 p/m²</span></h2>
      {rows.length === 0 ? (
        <p className="muted">Run the plans to fill the zone table.</p>
      ) : (
        <div className="oc-table">
          <table>
            <thead><tr><th>Zone</th><th>People</th><th>Trend</th><th>To 4/m²</th></tr></thead>
            <tbody>
              {rows.slice(0, 8).map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="oc-num">{n(r.people)}</td>
                  <td className={r.trendPerMin > 0 ? 'bad' : 'muted'}>{r.trendPerMin > 0 ? '+' : ''}{n(r.trendPerMin)}/min</td>
                  <td>{r.etaMin === null ? '-' : r.etaMin === 0 ? 'now' : `${r.etaMin < 1 ? '<1' : Math.round(r.etaMin)} min`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Parking occupancy per named lot, computed from density. */
export function LotBoard({ map, run }: { map: MapBundle; run: RunHandle }) {
  const rows = lotRows(map, run.latest.current?.density);
  return (
    <section className="panel">
      <h2>Lots <span className="muted">· occupancy from the crowd grid</span></h2>
      {rows.length === 0 ? (
        <p className="muted">Run the plans to fill the lot board.</p>
      ) : (
        <ol className="lot-board">
          {rows.slice(0, 8).map((r) => (
            <li key={r.id}>
              <span>{r.name}</span>
              <span className="oc-bar" style={{ ['--value' as string]: `${Math.min(100, r.occupancy * 100)}%` }} />
              <b>{Math.round(r.occupancy * 100)}%</b>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Read-only roster: every officer marker, one row each. */
export function OfficerRoster({ map, run }: { map: MapBundle; run: RunHandle }) {
  const rows = rosterRows(map, run.scene.current?.officers);
  return (
    <section className="panel">
      <h2>Officer roster <span className="muted">· {rows.length} officers</span></h2>
      {rows.length === 0 ? (
        <p className="muted">Waiting for the next frame…</p>
      ) : (
        <div className="oc-table">
          <table>
            <thead><tr><th>Unit</th><th>Order</th><th>ETA</th><th>Spoken to</th><th>Followed</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.unit}</td>
                  <td>{r.order}</td>
                  <td>{r.etaMin === null ? '—' : `${r.etaMin.toFixed(1)} min`}</td>
                  <td className="oc-num">{n(r.told)}</td>
                  <td>{r.followRate === null ? '—' : `${Math.round(r.followRate * 100)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">Read-only. The plan decides where they go; values update with every frame ({clockText(run.latest.current?.frame.t ?? 0)}).</p>
    </section>
  );
}
