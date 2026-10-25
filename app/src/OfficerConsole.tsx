import {useState} from 'react';
import type {OfficerStatus,PoliceOrder} from '../../engine/src/edits.ts';
import {policeCopy as c} from './police-copy.ts';
type ReportKind=Extract<PoliceOrder,{type:'officer_report'}>['kind'];
export function OfficerConsole({officer,disabled,following,onFollow,onBackup,onReport,nearby}:{officer:OfficerStatus|undefined;disabled:boolean;following:boolean;onFollow:()=>void;onBackup:()=>void;onReport:(kind:ReportKind)=>void;nearby:{name:string;etaS:number}[]}) {
  const [ack,setAck]=useState(''),[kind,setKind]=useState<ReportKind>('crowd crush');
  const key=officer?.mission?`${officer.mission.startedAt}:${officer.mission.targetCell}`:officer?.patrol?.name??'standby';
  return <aside className="side officer-console"><section className="block">
    <h2>{officer?.unit??c.chooseUnit}</h2><p className="muted">{c.demo}</p><h3>{c.assignmentCard}</h3>
    <p>{officer?.mission?.reason || (officer?.state==='standby'?c.standby:officer?.state.replaceAll('_',' '))}</p>
    {officer?.mission&&<p>{officer.mission.phase}{officer.etaS!==null?`, walking ETA ${Math.ceil(officer.etaS/60)} min`:''}</p>}
    {officer?.patrol&&<p>{officer.patrol.name}: waypoint {officer.patrol.index+1} of {officer.patrol.waypoints.length}</p>}
    <div className="police-actions"><button className="primary" disabled={!officer||ack===key} onClick={()=>setAck(key)}>{ack===key?c.acknowledged:c.acknowledge}</button>
      <button disabled aria-pressed={officer?.state==='en_route'}>{c.enRoute}</button><button disabled aria-pressed={officer?.state==='on_scene'}>{c.onScene}</button></div>
    <div className="police-actions"><button disabled={disabled||!officer} onClick={onBackup}>{c.backup}</button><button className="ghost" onClick={onFollow}>{following?c.freeLook:c.backToMe}</button></div>
    <label>{c.report}<select value={kind} onChange={e=>setKind(e.target.value as ReportKind)}>{c.reports.map(k=><option key={k} value={k}>{k[0]!.toUpperCase()+k.slice(1)}</option>)}</select></label>
    <button disabled={disabled||!officer} onClick={()=>onReport(kind)}>{c.report}</button>
    <p className="muted">{c.supervisorOnly}</p><p className="muted">{c.sharedRole}</p>
    <h3>{c.nearby}</h3><ul>{nearby.map((v,i)=><li key={i}>{v.name}: {Math.ceil(v.etaS/60)} min</li>)}</ul>
  </section></aside>;
}
