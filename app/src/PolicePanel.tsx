import {Roadblocks} from './Roadblocks.tsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CELL_SIZE_M, type MapBundle, type Incident } from '../../contracts.ts';
import type { OfficerStatus, PoliceOrder } from '../../engine/src/edits.ts';
import { isGateDoor } from './barricade.ts';
import { clockText } from './story.ts';
import type { RunHandle } from './useRun.ts';
import {dispatchSuggestions, responseTargets} from './suggestions.ts';
import type {PoliceHotspot} from './congestion.ts';
import {policeCopy} from './police-copy.ts';
import {patrolBeats} from '../../world/src/officers.ts';
import {coverage} from './coverage.ts';
import {classifyGates,type GateSample} from './gate-health.ts';
import { afterActionHtml, lastUndoable, timeline } from './after-action.ts';

function download(name: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export type PolicePickMode = null | { kind: 'barricade';blocks?:'all'|'vehicles'|'pedestrians';reachM?:number;replaceId?:string } | { kind: 'dispatch'; officerIds: string[] }
  | {kind:'response';officerIds:string[];mission:Extract<PoliceOrder,{type:'respond'}>}
  | {kind:'add_officer';unit:string}
  | {kind:'traffic_point';officerIds:string[]}
  | {kind:'marker';markerKind:'staging'|'medical'|'pa';radiusCells:number}
  | {kind:'officer_report';reportKind:Extract<PoliceOrder,{type:'officer_report'}>['kind']};

interface PolicePanelProps {
  onFocus?:(cell:number)=>void;
  hotspots?: PoliceHotspot[];
  incident?: Incident;
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
    case 'place_marker':return `Placed ${order.marker.name} marker.`;
    case 'remove_marker':return 'Removed a marker.';
    case 'officer_report': return `${units([order.officerId])} reported ${order.kind}.`;
    case 'officer_ack': return `${units([order.officerId])} acknowledged the assignment.`;
    case 'report_decision': return 'Dismissed an officer request.';
    case 'patrol': return `${units(order.officerIds)} assigned to ${order.name ?? 'an outdoor patrol'}.`;
    case 'resume_patrol': return `${units(order.officerIds)} resumed their patrol.`;
    case 'add_officer': return `Placed synthetic unit ${order.unit}.`;
    case 'remove_officer': return `Removed ${units([order.officerId])}.`;
    case 'respond': return `${units(order.officerIds)} responding: ${order.reason}. Return after ${Math.round(order.returnAfterS/60)} minutes on scene.`;
    case 'dismiss_suggestion': return `Dismissed a response suggestion${order.reason ? `: ${order.reason}` : '.'}`;
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
export function PolicePanel({ map, run, label, disabled, started, onOrder, armPick, pickMode, hint, hotspots = [], incident,onFocus }: PolicePanelProps) {
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
  const beats=useMemo(()=>patrolBeats(map),[map]);
  const [beatIndex,setBeatIndex]=useState(0);
  const [markerKind,setMarkerKind]=useState<'staging'|'medical'|'pa'>('staging');
  const [paRadius,setPaRadius]=useState(30);
  const [blockKind,setBlockKind]=useState<'all'|'vehicles'|'pedestrians'>('vehicles');
  const [blockLength,setBlockLength]=useState(20);
  const [unitName,setUnitName]=useState('Demo unit');
  const [reachMinutes,setReachMinutes]=useState(0);
  const scene = run.scene.current;
  const officers = scene?.officers ?? [];
  const targets = responseTargets(map, hotspots, incident, scene?.t, run.latest.current?.frame.vehicles);
  const gateHistory = useRef<GateSample[]>([]);
  const durations = useRef(new Map<string, number>());
  useEffect(() => {
    const t = scene?.t;
    if (t === undefined) return;
    const samples = gateHistory.current;
    const last = samples[samples.length - 1];
    if (last && t < last.t) {
      samples.length = 0;
      durations.current.clear();
    }
    if (!last || last.t !== t) samples.push({t, gates: scene?.gates ?? []});
    if (samples.length > 240) samples.splice(0, samples.length - 240);
    for (const target of targets) if (!durations.current.has(target.spot.where)) durations.current.set(target.spot.where, t);
  }, [scene?.t, scene?.gates, targets]);
  const health = useMemo(() => classifyGates(gateHistory.current, scene ? {t: scene.t, gates: scene.gates} : null), [scene?.t, scene?.gates]);
  const healthByPlace = useMemo(() => new Map(health.map((item) => [item.place, item])), [health]);
  const suggestions = scene ? dispatchSuggestions(map, targets, scene, {durations: durations.current, gateHealth: healthByPlace}) : [];
  const [dismissReason, setDismissReason] = useState('');
  const reachCoverage=useMemo(()=>coverage(map,officers,hotspots,reachMinutes),[map,scene?.officers,hotspots,reachMinutes]);
  const officerIds = selected.filter((id) => officers.some((o) => o.id === id));
  const barricades = new Map((scene?.barricades ?? []).map((b) => [b.id, b]));
  for (const street of streets) if (scene?.closed.includes(street.id)) barricades.set(street.id, street);
  const requests=(scene?.orders??[]).flatMap(e=>e.order.type==='officer_report'?[{t:e.t,order:e.order}]:[]).filter(e=>!scene?.orders?.some(d=>(d.order.type==='respond'||d.order.type==='report_decision')&&d.order.reportId===e.order.reportId));
  const arrivals=new Map<string,number>();for(const a of scene?.responseArrivals??[]){const key=a.startedAt+':'+a.targetCell;arrivals.set(key,Math.min(arrivals.get(key)??Infinity,a.arrivedAt-(a.suggestionAt??a.startedAt)));}
  const slowestResponse=Math.max(0,...(scene?.responses??[]).flatMap(r=>r.units.map(u=>u.etaS??0)));
  const undoable = lastUndoable(scene);
  const entries = timeline(scene, (order) => describeOrder(order, map, officers),
    (id) => officers.find((o) => o.id === id)?.unit ?? 'A unit');
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
        <section><h3>{policeCopy.requests} ({requests.length})</h3>{requests.map(r=>{const candidates=(scene?.responses?.find(v=>v.cell===r.order.toCell)?.units??[]).filter(u=>u.id!==r.order.officerId&&u.etaS!==null&&officers.find(o=>o.id===u.id)?.state==='standby').sort((a,b)=>a.etaS!-b.etaS!);return <article className="police-picker" key={r.order.reportId}><p>{officers.find(o=>o.id===r.order.officerId)?.unit}: {r.order.kind}, {clockText(r.t)}</p>{!candidates.length&&<p>{policeCopy.noFreeUnit}</p>}<div className="police-actions"><button disabled={!candidates.length} onClick={()=>onOrder({type:'respond',officerIds:[candidates[0]!.id],toCell:r.order.toCell,kind:r.order.kind==='traffic'?'traffic':'incident',reason:'Officer request: '+r.order.kind,returnAfterS:180,reportId:r.order.reportId})}>{policeCopy.requestSend}</button><button className="ghost" onClick={()=>onOrder({type:'report_decision',reportId:r.order.reportId,decision:'dismissed'})}>{policeCopy.requestDismiss}</button></div></article>;})}</section>
        {arrivals.size>0&&<p>{policeCopy.measured([...arrivals.values()].reduce((a,b)=>a+b,0)/arrivals.size,arrivals.size)}</p>}
        <section><h3>{policeCopy.coverage}</h3><p className="muted">{policeCopy.coverageRule}</p>
          <label>Reachable within<select value={reachMinutes} onChange={e=>setReachMinutes(Number(e.target.value))}><option value={0}>Now only</option><option value={2}>2 min</option><option value={5}>5 min</option><option value={10}>10 min</option></select></label>
          <p>{reachCoverage.outdoorShare===null?'No outdoor area':`${(reachCoverage.outdoorShare*100).toFixed(1)}% of outdoor walkable area within reach`}. {reachCoverage.uncoveredHotspots} hotspot centres outside reach. {slowestResponse>0?`Slowest suggested walk ${Math.ceil(slowestResponse/60)} min.`:'No routed response time yet.'}{reachMinutes>0&&reachCoverage.reachableShare!==null?` ${(reachCoverage.reachableShare*100).toFixed(1)}% reachable within ${reachMinutes} min on foot (straight-line estimate).`:''}</p></section>
        <section aria-label={policeCopy.title}>
          <h3>{policeCopy.title} ({suggestions.length})</h3>
          <p className="muted">{policeCopy.rule}</p>
          {suggestions.length > 0 && <button className="primary" onClick={()=>suggestions.forEach(s=>onOrder(s.order))}>{policeCopy.sendAll}</button>}
          {suggestions.length > 0 && <label>Dismissal reason (optional)<input value={dismissReason} maxLength={120} onChange={e=>setDismissReason(e.target.value)} placeholder="For example: unit already nearby" /></label>}
          {suggestions.map(s=><article className="police-picker" key={s.cell}>
            <h4>{s.what}</h4><p>{s.why}</p><p className="muted">{s.cost}. Walking ETA {Math.ceil(s.etaS/60)} min.</p>
            <p className="muted">{policeCopy.duration(s.order.returnAfterS)}</p>
            <div className="police-actions"><button onClick={()=>onOrder(s.order)}>{policeCopy.accept}</button>
              <button className="ghost" onClick={()=>armPick({kind:'response',officerIds:s.order.officerIds,mission:s.order})}>{policeCopy.modify}</button>
              <button className="ghost" onClick={()=>{onOrder({type:'dismiss_suggestion',toCell:s.cell,score:s.spot.score,...(dismissReason.trim()?{reason:dismissReason.trim()}:{})});setDismissReason('');}}>{policeCopy.dismiss}</button></div>
          </article>)}
          {!suggestions.length && <p className="muted">{targets.length && !scene?.responses?.length ? policeCopy.routing : policeCopy.empty}</p>}
          <p className="muted">{policeCopy.mission}</p>
          {officers.some(o=>o.mission) && <h4>{policeCopy.assignment}</h4>}
          {officers.filter(o=>o.mission).map(o=><p key={o.id}>{o.unit}: {o.mission!.phase}. {o.mission!.reason}
            {o.mission!.arrivedAt!==null && o.mission!.returnAfterS!==null && o.mission!.phase==='working' && ` Return in ${Math.max(0,Math.ceil((o.mission!.arrivedAt+o.mission!.returnAfterS-scene!.t)/60))} min.`}</p>)}
        </section>
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
                    <td>{officer.state === 'patrolling' ? 'On patrol' : officer.state === 'standby' ? 'Standby' : officer.state === 'en_route' ? 'On the way' : 'On scene'}</td>
                    <td>{map.places[officer.place]?.name ?? 'street'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {officers.length === 0 && <p className="muted">Starts with the run.</p>}
          {beats.length>0 && <label>Patrol beat<select value={beatIndex} onChange={e=>setBeatIndex(Number(e.target.value))}>{beats.map((b,i)=><option value={i} key={i}>{b.name}</option>)}</select></label>}
          <div className="police-actions">
            <button disabled={!officerIds.length||!beats[beatIndex]} onClick={()=>{const b=beats[beatIndex]!;onOrder({type:'patrol',officerIds,waypoints:b.waypoints,loop:b.loop,name:b.name});}}>{policeCopy.patrol}</button>
            <button className="ghost" disabled={!officerIds.length} onClick={()=>onOrder({type:'resume_patrol',officerIds})}>{policeCopy.resume}</button>
          </div>
          <label>{policeCopy.unitName}<input value={unitName} maxLength={64} onChange={e=>setUnitName(e.target.value)} /></label>
          <div className="police-actions"><button disabled={!unitName.trim()} onClick={()=>armPick({kind:'add_officer',unit:unitName})}>{policeCopy.add}</button>
            <button className="ghost" disabled={!officerIds.length} onClick={()=>officerIds.forEach(id=>onOrder({type:'remove_officer',officerId:id}))}>{policeCopy.remove}</button></div>
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
                  {/* Gates, the bowl and the combined lots: the map has ~140 small lots,
                      and a specific one is better picked by clicking the map. */}
                  {map.places.map(
                    (place, i) =>
                      place.cells.length > 0 &&
                      (place.kind !== 'parking' || place.id === 'lots') && (
                        <option key={place.id} value={i}>
                          {place.name}
                        </option>
                      ),
                  )}
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
          <h3>Map placements</h3>
          <label>Marker type<select value={markerKind} onChange={e=>setMarkerKind(e.target.value as typeof markerKind)}><option value="staging">Staging marker</option><option value="medical">Medical tent marker</option><option value="pa">PA speaker marker</option></select></label>
          <label>PA radius in metres<input type="number" min={2} max={200} value={paRadius} onChange={e=>setPaRadius(Math.max(2,Math.min(200,Number(e.target.value)||2)))}/></label>
          <button onClick={()=>armPick({kind:'marker',markerKind,radiusCells:paRadius/CELL_SIZE_M})}>Place marker on map</button>
          <p className="muted">Staging and medical tents are markers. PA markers can define an alert area.</p>
          {(scene?.markers??[]).map(m=><p key={m.id}>{m.name} <button className="ghost" onClick={()=>onOrder({type:'remove_marker',id:m.id})}>Remove</button></p>)}
          <h3>Barricades</h3>
          <label>Block traffic<select value={blockKind} onChange={e=>setBlockKind(e.target.value as typeof blockKind)}><option value="vehicles">Vehicles only</option><option value="all">Vehicles and pedestrians</option><option value="pedestrians">Pedestrians only</option></select></label><label>Street reach in metres<input type="number" min={2} max={80} step={2} value={blockLength} onChange={e=>setBlockLength(Math.max(2,Math.min(80,Number(e.target.value)||2)))}/></label>
          <button className="small" onClick={() => armPick({ kind: 'barricade',blocks:blockKind,reachM:blockLength })}>Barricade a street</button>
          <button className="small" disabled={!officerIds.length} onClick={() => armPick({kind:'traffic_point',officerIds})}>Place traffic control point</button>
          {pickMode && <button className="small ghost" onClick={() => armPick(null)}>Cancel map pick</button>}
          {barricades.size === 0 && <p className="muted">No street barricades up.</p>}
          <ul className="police-barricades">
            {[...barricades.values()].map((b) => (
              <li key={b.id}>
                <button className="small ghost" onClick={()=>armPick({kind:'barricade',blocks:'blocks' in b?b.blocks??'all':'all',reachM:blockLength,replaceId:b.id})}>Move or resize</button><span>{b.name} ({'blocks' in b?b.blocks??'all':'all'} blocked)</span>
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
            const pa=scene?.markers?.filter(m=>m.kind==='pa')??[];
            const zone=pa.length?map.cells.flatMap((_,cell)=>pa.some(m=>Math.hypot(cell%map.width-m.cell%map.width,Math.floor(cell/map.width)-Math.floor(m.cell/map.width))<=m.radiusCells)?[cell]:[]):undefined;
            onOrder({ type: 'alert', channel, message: message.trim(), reachShare: reachPct / 100,zoneCells:channel==='pa'?zone:undefined });
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

      <Roadblocks map={map} scene={scene} vehicles={run.latest.current?.frame.vehicles} onFocus={onFocus}/>
      <section>
        <h3>Order log</h3>
        {!scene?.orders?.length && <p className="muted">No orders carried out yet.</p>}
        <div className="police-actions">
          <button className="small ghost" disabled={disabled || !undoable} onClick={() => undoable && onOrder(undoable.inverse)}
            title={undoable ? `Undo: ${describeOrder(undoable.order, map, officers)}` : undefined}>
            {undoable ? `Undo last order (${clockText(undoable.t)})` : 'Nothing to undo'}
          </button>
          <button className="small ghost" disabled={!entries.length} onClick={() => download(`plan-${label}-timeline.json`, 'application/json',
            JSON.stringify({ plan: label, map: map.name, scorecard: run.scorecard, timeline: entries }, null, 2))}>Export timeline (JSON)</button>
          <button className="small ghost" disabled={!entries.length} onClick={() => {
            const page = window.open('', '_blank');
            if (!page) return;
            page.document.write(afterActionHtml(`After-action report: ${map.name}, plan ${label}`, entries, run.scorecard));
            page.document.close();
            page.print();
          }}>Print after-action report</button>
        </div>
        <p className="muted">Undo sends the opposite order now; it never rewinds the run.</p>
        <ol className="police-log">
          {[...(scene?.orders ?? [])].reverse().map(({ t, order }, i) => (
            <li key={i}><span className="muted">{clockText(t)}</span> {describeOrder(order, map, officers)}</li>
          ))}
        </ol>
      </section>
    </div>
  );
}
