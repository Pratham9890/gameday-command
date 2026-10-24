import { useEffect, useMemo, useState } from 'react';
import { CELL_SIZE_M, type MapBundle } from '../../contracts.ts';
import type { OfficerStatus, PoliceOrder } from '../../engine/src/edits.ts';
import { isGateDoor } from './barricade.ts';
import { clockText } from './story.ts';
import type { RunHandle } from './useRun.ts';

export type PolicePickMode = null | { kind: 'barricade' } | { kind: 'dispatch'; officerIds: string[] };

interface PolicePanelProps {
  map: MapBundle;
  run: RunHandle;
  label: string;
  disabled: boolean;
  started: boolean;
  onOrder: (order: PoliceOrder) => void;
  armPick: (mode: PolicePickMode) => void;
  pickMode: PolicePickMode;
  hint: string | null;
}

/** Explain an applied order without exposing the engine's ids. */
export function describeOrder(order: PoliceOrder, map: MapBundle, officers: OfficerStatus[]): string {
  const place = (id: string) => map.places.find((p) => p.id === id)?.name ?? 'a gate';
  const units = (ids: string[]) => ids.length === 1
    ? officers.find((o) => o.id === ids[0])?.unit ?? '1 officer'
    : `${ids.length} officers`;
  switch (order.type) {
    case 'dispatch': {
      const where = map.places.find((p) => p.cells.includes(order.toCell))?.name
        ?? `${(order.toCell % map.width + 0.5) * CELL_SIZE_M}, ${(Math.floor(order.toCell / map.width) + 0.5) * CELL_SIZE_M} m`;
      return `Sent ${units(order.officerIds)} to ${where}.`;
    }
    case 'recall':
      return `Sent ${units(order.officerIds)} back to post.`;
    case 'gate':
      return `${order.closed ? 'Closed' : 'Opened'} ${map.closables.find((c) => c.id === order.closableId)?.name ?? 'a gate'}.`;
    case 'barricade':
      return `${order.closed ? 'Put up' : 'Removed'} ${order.name ?? map.closables.find((c) => c.id === order.closableId)?.name ?? 'a street barricade'}.`;
    case 'redirect':
      return `Redirected ${place(order.fromPlaceId)} to ${place(order.toPlaceId)}.`;
    case 'alert':
      return `${order.channel === 'pa' ? 'PA' : 'Phone'} alert (${Math.round(order.reachShare * 100)}% reach): “${order.message}”`;
    case 'release':
      return 'Ended the game; everyone heads for the exits.';
  }
}

/** Live commands for the selected plan; App owns map picking and worker routing. */
export function PolicePanel({ map, run, label, disabled, started, onOrder, armPick, pickMode, hint }: PolicePanelProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [destination, setDestination] = useState(-1);
  const gates = useMemo(() => map.places.filter((p) => p.kind === 'gate'), [map]);
  const streets = useMemo(() => map.closables.filter((c) => !isGateDoor(map, c)), [map]);
  const [fromGate, setFromGate] = useState(gates[0]?.id ?? '');
  const [toGate, setToGate] = useState(gates[1]?.id ?? gates[0]?.id ?? '');
  const [channel, setChannel] = useState<'pa' | 'phone'>('pa');
  const [message, setMessage] = useState('');
  const [reach, setReach] = useState('60');
  const [confirmRelease, setConfirmRelease] = useState(false);
  const scene = run.scene.current;
  const officers = scene?.officers ?? [];
  const officerIds = selected.filter((id) => officers.some((o) => o.id === id));
  const barricades = new Map((scene?.barricades ?? []).map((b) => [b.id, b]));
  for (const street of streets) if (scene?.closed.includes(street.id)) barricades.set(street.id, street);
  const reachPct = Number(reach);
  const reachValid = reach.trim() !== '' && Number.isFinite(reachPct) && reachPct >= 0 && reachPct <= 100;

  useEffect(() => {
    if (disabled) {
      setSending(false);
      setConfirmRelease(false);
    }
  }, [disabled]);

  return (
    <div className="police-orders">
      <p className="muted">Orders go to Plan {label} only — the other plans keep to their written plan.</p>
      {disabled && <p className="muted">{started ? 'Orders are live only — leave the replay to give orders.' : 'Start the run to give orders.'}</p>}
      {hint && <p className="warn" role="status">{hint}</p>}
      <fieldset disabled={disabled}>
        <section>
          <h3>Officers</h3>
          <div className="police-actions">
            <button className="small ghost" onClick={() => setSelected(officers.map((o) => o.id))}>All</button>
            <button className="small ghost" onClick={() => setSelected([])}>None</button>
            <span className="muted">{officerIds.length} selected</span>
          </div>
          <div className="police-officers">
            <table>
              <thead><tr><th>Unit</th><th>State</th><th>Where</th></tr></thead>
              <tbody>
                {officers.map((officer) => (
                  <tr key={officer.id}>
                    <td>
                      <label className="police-check">
                        <input type="checkbox" checked={officerIds.includes(officer.id)} onChange={(e) => {
                          setSelected(e.target.checked ? [...officerIds, officer.id] : officerIds.filter((id) => id !== officer.id));
                        }} />
                        {officer.unit}
                      </label>
                    </td>
                    <td>{officer.state === 'standby' ? 'Standby' : officer.state === 'en_route' ? 'On the way' : 'On scene'}</td>
                    <td>{map.places[officer.place]?.name ?? 'street'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {officers.length === 0 && <p className="muted">Starts with the run.</p>}
          <div className="police-actions">
            <button className="small" disabled={officerIds.length === 0} onClick={() => setSending((v) => !v)}>Send to…</button>
            <button className="small ghost" disabled={officerIds.length === 0} onClick={() => onOrder({ type: 'recall', officerIds })}>Back to post</button>
          </div>
          {sending && (
            <div className="police-picker">
              <label>
                Destination
                <select value={destination} onChange={(e) => setDestination(Number(e.target.value))}>
                  <option value={-1}>Spot I click on the map</option>
                  {map.places.map((place, i) => place.cells.length > 0 && <option key={place.id} value={i}>{place.name}</option>)}
                </select>
              </label>
              <button className="small primary" disabled={officerIds.length === 0} onClick={() => {
                if (destination === -1) armPick({ kind: 'dispatch', officerIds });
                else {
                  const cells = map.places[destination]!.cells;
                  onOrder({ type: 'dispatch', officerIds, toCell: cells[Math.floor(cells.length / 2)]! });
                }
                setSending(false);
              }}>Send</button>
            </div>
          )}
        </section>

        <section>
          <h3>Barricades</h3>
          <button className="small" onClick={() => armPick({ kind: 'barricade' })}>Barricade a street</button>
          {pickMode && <button className="small ghost" onClick={() => armPick(null)}>Cancel map pick</button>}
          {barricades.size === 0 && <p className="muted">No street barricades up.</p>}
          <ul className="police-barricades">
            {[...barricades.values()].map((b) => (
              <li key={b.id}>
                <span>{b.name}</span>
                <button className="small ghost" onClick={() => onOrder({ type: 'barricade', closableId: b.id, closed: false, name: b.name })}>Remove</button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3>Redirect</h3>
          <label>From gate
            <select value={fromGate} onChange={(e) => setFromGate(e.target.value)}>
              {gates.map((gate) => <option key={gate.id} value={gate.id}>{gate.name}</option>)}
            </select>
          </label>
          <label>To gate
            <select value={toGate} onChange={(e) => setToGate(e.target.value)}>
              {gates.map((gate) => <option key={gate.id} value={gate.id}>{gate.name}</option>)}
            </select>
          </label>
          <button className="small" disabled={!fromGate || !toGate || fromGate === toGate} onClick={() => onOrder({ type: 'redirect', fromPlaceId: fromGate, toPlaceId: toGate })}>Redirect</button>
        </section>

        <section>
          <h3>Alert</h3>
          <label>Channel
            <select value={channel} onChange={(e) => {
              const next = e.target.value as 'pa' | 'phone';
              setChannel(next);
              setReach(next === 'pa' ? '60' : '35');
            }}>
              <option value="pa">PA</option><option value="phone">Phone</option>
            </select>
          </label>
          <label>Message<input type="text" value={message} onChange={(e) => setMessage(e.target.value)} /></label>
          <label>Reach %<input type="number" min={0} max={100} value={reach} onChange={(e) => setReach(e.target.value)} /></label>
          <button className="small" disabled={!message.trim() || !reachValid} onClick={() => {
            onOrder({ type: 'alert', channel, message: message.trim(), reachShare: reachPct / 100 });
            setMessage('');
          }}>Send</button>
        </section>

        <section>
          {confirmRelease ? (
            <>
              <p>Everyone heads for the exits. Sure?</p>
              <div className="police-actions">
                <button className="small primary" onClick={() => { onOrder({ type: 'release' }); setConfirmRelease(false); }}>Confirm</button>
                <button className="small ghost" onClick={() => setConfirmRelease(false)}>Cancel</button>
              </div>
            </>
          ) : <button className="small" onClick={() => setConfirmRelease(true)}>Release the crowd (end the game now)</button>}
        </section>
      </fieldset>

      <section>
        <h3>Order log</h3>
        {!scene?.orders?.length && <p className="muted">No orders carried out yet.</p>}
        <ol className="police-log">
          {[...(scene?.orders ?? [])].reverse().map(({ t, order }, i) => (
            <li key={i}><span className="muted">{clockText(t)}</span> {describeOrder(order, map, officers)}</li>
          ))}
        </ol>
      </section>
    </div>
  );
}
