import { useEffect, useMemo, useState } from 'react';
import type { FanType, MapBundle } from '../../contracts.ts';
import { DOT_GROUP_SIZE, DOT_STATES } from '../../contracts.ts';
import { groupName, rgbCss, shirtColor, STATE_RGB } from './people.ts';
import type { RunHandle } from './useRun.ts';

export interface EditRequest {
  fanType?: number;
  sendTo?: number;
  /** 0 = just this group, else every group within this many meters of them. */
  radiusM: number;
}

export interface InspectorProps {
  map: MapBundle;
  types: FanType[];
  run: RunHandle;
  label: string;
  dot: number;
  /** Showing a replayed frame: edits only make sense on the live run. */
  scrubbing: boolean;
  appliedNote: string | null;
  onApply: (edit: EditRequest) => void;
  onFocus: () => void;
  onClose: () => void;
}

const kickoff = (t: number) => `${t < 0 ? '−' : '+'}${Math.abs(Math.round(t / 60))} min`;
const css = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const RADII = [0, 10, 25] as const;

/** Places a commander can send a group to by hand. */
export function destinations(map: MapBundle): { index: number; label: string }[] {
  const out: { index: number; label: string }[] = [];
  map.places.forEach((place, index) => {
    if (place.kind === 'gate') out.push({ index, label: place.name });
    else if (place.kind === 'seating') out.push({ index, label: 'Their seat' });
    else if (place.kind === 'concourse' || place.kind === 'shelter') out.push({ index, label: `${place.name} (shelter)` });
  });
  const lots = map.places.findIndex((p) => p.kind === 'parking');
  if (lots >= 0) out.push({ index: lots, label: 'Leave: back to the car' });
  return out;
}

function Bar({ value, color }: { value: number; color?: string }) {
  return (
    <span className="bar">
      <i style={{ width: `${Math.round(value * 100)}%`, background: color }} />
    </span>
  );
}

export function Inspector({ map, types, run, label, dot, scrubbing, appliedNote, onApply, onFocus, onClose }: InspectorProps) {
  const info = run.inspected?.dot === dot ? run.inspected : null;
  const record = run.decisionsByDot.current?.get(dot);
  const typeIndex = info?.typeIndex ?? run.typeIndex.current?.[dot] ?? 0;
  const type = types[typeIndex];
  const state = info ? (DOT_STATES[info.state] ?? 'arriving') : null;
  const places = useMemo(() => destinations(map), [map]);

  const [fanType, setFanType] = useState(typeIndex);
  const [sendTo, setSendTo] = useState(-1);
  const [radius, setRadius] = useState(0);
  // A new group starts the form from who they are now.
  useEffect(() => {
    setFanType(typeIndex);
    setSendTo(-1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dot]);

  const nearby = useMemo(() => {
    const frame = run.latest.current?.frame;
    if (!frame || radius === 0) return 1;
    const x = frame.x[dot]!;
    const y = frame.y[dot]!;
    if (x < 0) return 1;
    let n = 0;
    for (let i = 0; i < frame.x.length; i++) {
      if (frame.x[i]! < 0) continue;
      if (Math.hypot(frame.x[i]! - x, frame.y[i]! - y) <= radius) n++;
    }
    return n;
  }, [run.latest, run.tick, dot, radius]);

  const changed = fanType !== typeIndex || sendTo >= 0;
  const gone = state === 'gone';

  return (
    <aside className="inspector">
      <header>
        <span className="swatch" style={{ background: css(shirtColor(types, typeIndex)) }} />
        <div>
          <h3>{groupName(dot)}</h3>
          <p className="muted">
            {type?.label ?? 'Fan'} · group of {DOT_GROUP_SIZE} · dot {dot} in run {label}
          </p>
        </div>
        <button className="small ghost" onClick={onClose} title="Close">
          ✕
        </button>
      </header>

      <section>
        {state ? (
          <p className="state">
            <i style={{ background: rgbCss(STATE_RGB[info!.state] ?? STATE_RGB[3]!) }} />
            <strong>{state}</strong>
            {info!.targetPlace >= 0 && !gone && <span className="muted">→ {map.places[info!.targetPlace]?.name}</span>}
          </p>
        ) : (
          <p className="muted">asking the worker…</p>
        )}
        {info && (
          <dl className="detail">
            <dt>arrives</dt>
            <dd>{kickoff(info.arriveAt)} from kickoff</dd>
            <dt>their gate</dt>
            <dd>{map.places[info.homeGate]?.name ?? '—'}</dd>
            <dt>through the gate</dt>
            <dd>{info.admitted ? 'yes' : 'not yet'}</dd>
            {info.edits > 0 && (
              <>
                <dt>your edits</dt>
                <dd className="warn">{info.edits}</dd>
              </>
            )}
          </dl>
        )}
        {type && (
          <div className="traits">
            <span>patience</span>
            <Bar value={type.traits.patience} />
            <span>compliance</span>
            <Bar value={type.traits.compliance} />
            <span>mobility</span>
            <Bar value={type.traits.mobility} />
            <span>walks at</span>
            <span className="muted">{type.walkSpeedMps.toFixed(2)} m/s</span>
          </div>
        )}
        <button className="small" onClick={onFocus}>
          Zoom to them
        </button>
      </section>

      <section>
        <h4>Latest decision</h4>
        {!record && <p className="muted">None yet. They are walking their route.</p>}
        {record && (
          <>
            <p>
              {record.situation.replace(/_/g, ' ')} at {kickoff(record.t)}: chose <strong>{record.picked.replace(/_/g, ' ')}</strong>
            </p>
            <div className="odds">
              {Object.entries(record.odds).map(([key, value]) => (
                <div key={key} className={key === record.picked ? 'on' : undefined}>
                  <span>{key.replace(/_/g, ' ')}</span>
                  <Bar value={value} />
                  <span className="muted">{Math.round(value * 100)}%</span>
                </div>
              ))}
            </div>
            <p className={`muted${record.source === 'default' ? ' warn' : ''}`}>
              answered by {record.source === 'default' ? 'fallback defaults' : record.source}
            </p>
          </>
        )}
      </section>

      <section className="edit">
        <h4>Change them</h4>
        <label>
          fan type
          <select value={fanType} onChange={(e) => setFanType(Number(e.target.value))}>
            {types.map((t, i) => (
              <option key={t.id} value={i}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          send to
          <select value={sendTo} onChange={(e) => setSendTo(Number(e.target.value))}>
            <option value={-1}>keep their route</option>
            {places.map((p) => (
              <option key={p.index} value={p.index}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <div className="scope">
          {RADII.map((r) => (
            <label key={r}>
              <input type="radio" name="scope" checked={radius === r} onChange={() => setRadius(r)} />
              {r === 0 ? 'this group' : `within ${r} m`}
            </label>
          ))}
        </div>
        <button
          className="primary"
          disabled={!changed || scrubbing || gone}
          onClick={() => {
            onApply({
              fanType: fanType !== typeIndex ? fanType : undefined,
              sendTo: sendTo >= 0 ? sendTo : undefined,
              radiusM: radius,
            });
            setSendTo(-1);
          }}
        >
          Apply to {nearby.toLocaleString()} {nearby === 1 ? 'group' : 'groups'} in all three plans
        </button>
        <p className="muted">
          {scrubbing
            ? 'Go back to live to edit. Edits change the running simulation, not a replayed frame.'
            : 'Lands at the same sim second in A, B and C, so the comparison stays fair. Rewinding to before it undoes it.'}
        </p>
        {appliedNote && <p className="ok-note">{appliedNote}</p>}
      </section>
    </aside>
  );
}
