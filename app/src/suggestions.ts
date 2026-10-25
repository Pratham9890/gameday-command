import type {Incident, MapBundle, VehicleFrame} from '../../contracts.ts';
import {CELL_SIZE_M,VEHICLE_STATES} from '../../contracts.ts';
import {roadJunctions} from '../../engine/src/junctions.ts';
import type {OfficerStatus, PoliceOrder, SceneInfo} from '../../engine/src/edits.ts';
import type {PoliceHotspot} from './congestion.ts';
import {POLICE_WORK_S} from './police-copy.ts';

/** Rank merged hotspots by observed score; incident zones are explicit requests.
 * Use worker walking ETAs; never substitute straight-line travel time. Prefer
 * standby units, then noncritical on-scene units. Reserve each unit once; keep
 * the last unit protecting a critical hotspot. Dismissals last 300 sim seconds
 * unless severity rises by 25%. No order is issued by this pure module.
 */
export function mergeHotspots(hotspots: PoliceHotspot[]): PoliceHotspot[] {
  const merged: PoliceHotspot[]=[];
  for(const input of hotspots) {
    let spot={...input}, i=0;
    while(i<merged.length) {
      const other=merged[i]!;
      if(spot.x0>other.x1+6 || other.x0>spot.x1+6 || spot.y0>other.y1+6 || other.y0>spot.y1+6) {i++;continue;}
      merged.splice(i,1);
      spot={...spot,x0:Math.min(spot.x0,other.x0),y0:Math.min(spot.y0,other.y0),x1:Math.max(spot.x1,other.x1),y1:Math.max(spot.y1,other.y1),
        crowdedPeople:spot.crowdedPeople+other.crowdedPeople,stoppedVehicles:spot.stoppedVehicles+other.stoppedVehicles,
        slowVehicles:spot.slowVehicles+other.slowVehicles,peakDensity:Math.max(spot.peakDensity,other.peakDensity),score:spot.score+other.score,
        level:spot.level==='critical'||other.level==='critical'?'critical':spot.level==='high'||other.level==='high'?'high':'watch'};
      i=0;
    }
    merged.push(spot);
  }
  return merged;
}

export function responseTargets(map: MapBundle, hotspots: PoliceHotspot[], incident?: Incident, t = -Infinity, vehicles?:VehicleFrame) {
  const spots = mergeHotspots(hotspots), incidentSpots=new Set<PoliceHotspot>();
  if (incident && t >= incident.at && incident.kind !== 'game_end' && incident.cells?.length) {
    const c = incident.cells[Math.floor(incident.cells.length / 2)]!;
    const x = c % map.width, y = Math.floor(c / map.width);
    if (!spots.some(s => x >= s.x0 - 6 && x <= s.x1 + 6 && y >= s.y0 - 6 && y <= s.y1 + 6)) {
      spots.push({rank: spots.length+1, kind: 'crowd', level: 'high', where: incident.note ?? incident.kind.replaceAll('_',' '),
        crowdedPeople: 0, peakDensity: 0, stoppedVehicles: 0, slowVehicles: 0, score: 1,
        x0:x,y0:y,x1:x,y1:y,cx:(x+0.5)*CELL_SIZE_M,cy:(y+0.5)*CELL_SIZE_M});
      incidentSpots.add(spots[spots.length-1]!);
    }
  }
  return spots.slice(0,8).flatMap(spot => {
    // The exterior edge nearest a gate, never the centre of an impassable block.
    const gates = map.places.filter(p=>p.kind==='gate').flatMap(p=>p.cells.slice(0,1));
    const cx=spot.cx/CELL_SIZE_M, cy=spot.cy/CELL_SIZE_M;
    const gate = gates.sort((a,b)=>Math.hypot(a%map.width-cx,Math.floor(a/map.width)-cy)-Math.hypot(b%map.width-cx,Math.floor(b/map.width)-cy))[0];
    const gx=gate===undefined?cx:gate%map.width, gy=gate===undefined?cy:Math.floor(gate/map.width);
    let cell=-1, best=Infinity;
    for(let y=Math.max(0,spot.y0-2);y<=Math.min(map.height-1,spot.y1+2);y++) for(let x=Math.max(0,spot.x0-2);x<=Math.min(map.width-1,spot.x1+2);x++) {
      const c=y*map.width+x, k=map.cells[c];
      if(k!=='walk' && k!=='road' && k!=='parking') continue;
      const edge = x<=spot.x0 || x>=spot.x1 || y<=spot.y0 || y>=spot.y1;
      if(!edge) continue;
      const d=Math.hypot(x-gx,y-gy)+Math.hypot(x-cx,y-cy)*0.1;
      if(d<best) {best=d;cell=c;}
    }
    let trafficPoint=false;
    if(spot.stoppedVehicles>0) {
      let vx=0,vy=0;
      if(vehicles)for(let i=0;i<vehicles.x.length;i++) {
        const state=VEHICLE_STATES[vehicles.state[i]!];
        if(state==='parked'||state==='waiting'||state==='gone'||state==='parking'||vehicles.speed[i]!>=1.5)continue;
        const x=vehicles.x[i]!/CELL_SIZE_M,y=vehicles.y[i]!/CELL_SIZE_M;
        if(x<spot.x0||x>spot.x1+1||y<spot.y0||y>spot.y1+1)continue;
        vx+=Math.cos(vehicles.heading[i]!);vy+=Math.sin(vehicles.heading[i]!);
      }
      const candidates=roadJunctions(map).filter(c=>Math.hypot(c%map.width-cx,Math.floor(c/map.width)-cy)*CELL_SIZE_M<=120);
      const score=(c:number)=>{
        const dx=c%map.width-cx,dy=Math.floor(c/map.width)-cy;
        return Math.hypot(dx,dy)+(dx*vx+dy*vy>0?60:0);
      };
      candidates.sort((a,b)=>score(a)-score(b)||a-b);
      if(candidates[0]!==undefined){cell=candidates[0];trafficPoint=true;}
      else if(spot.crowdedPeople===0 && !incidentSpots.has(spot))return [];
    }
    if(cell<0 && incidentSpots.has(spot) && gate!==undefined)cell=gate;
    return cell<0?[]:[{cell,spot,incident:incidentSpots.has(spot),trafficPoint}];
  });
}

export function dispatchSuggestions(map: MapBundle, targets: ReturnType<typeof responseTargets>, scene: SceneInfo) {
  const reserved=new Set<string>();
  const distance=(cell:number, x:number,y:number)=>Math.hypot((cell%map.width+0.5)*CELL_SIZE_M-x,(Math.floor(cell/map.width)+0.5)*CELL_SIZE_M-y);
  const near=(cell:number,spot:PoliceHotspot)=>cell%map.width>=spot.x0-12 && cell%map.width<=spot.x1+12 &&
    Math.floor(cell/map.width)>=spot.y0-12 && Math.floor(cell/map.width)<=spot.y1+12;
  const protectedUnit=(o:OfficerStatus)=>targets.some(({spot})=>spot.level==='critical' && near(o.cell,spot) &&
    scene.officers.filter(p=>p.state==='on_scene' && near(p.cell,spot)).length<=1);
  return [...targets].sort((a,b)=>b.spot.score-a.spot.score).flatMap(({cell,spot,incident,trafficPoint})=>{
    if(scene.officers.some(o=>o.mission?.phase!=='returning' && o.mission && (o.mission.targetCell===cell || distance(o.mission.targetCell,spot.cx,spot.cy)<=36))) return [];
    if(scene.officers.some(o=>o.state==='on_scene' && distance(o.cell,spot.cx,spot.cy)<=20)) return [];
    const dismissed=scene.orders?.some(({t,order})=>order.type==='dismiss_suggestion' && scene.t-t<300 && scene.t>=t &&
      distance(order.toCell,spot.cx,spot.cy)<=36 && spot.score<order.score*1.25);
    if(dismissed) return [];
    const times=scene.responses?.find(r=>r.cell===cell)?.units ?? [];
    const available=scene.officers.filter(o=>!reserved.has(o.id) && o.state!=='en_route' && !protectedUnit(o))
      .flatMap(o=>{const eta=times.find(v=>v.id===o.id)?.etaS;return eta===null||eta===undefined?[]:[{o,eta}];})
      .sort((a,b)=>(a.o.state==='standby'?0:a.o.state==='patrolling'?1:2)-(b.o.state==='standby'?0:b.o.state==='patrolling'?1:2)||a.eta-b.eta||a.o.id.localeCompare(b.o.id));
    const chosen=available.slice(0,spot.level==='critical'?2:1);
    if(!chosen.length) return [];
    chosen.forEach(v=>reserved.add(v.o.id));
    const why=incident?spot.where:`${Math.round(spot.crowdedPeople).toLocaleString()} people packed, peak ${spot.peakDensity.toFixed(1)}/m²; ${spot.stoppedVehicles} vehicles stopped`;
    const order: Extract<PoliceOrder,{type:'respond'}>={type:'respond',officerIds:chosen.map(v=>v.o.id),toCell:cell,
      kind:trafficPoint?'traffic':incident?'incident':'crowd',reason:why,returnAfterS:POLICE_WORK_S};
    return [{cell,spot,order,etaS:Math.max(...chosen.map(v=>v.eta)),
      what:`Send ${chosen.map(v=>v.o.unit).join(' and ')} to ${spot.where}`,
      why,cost:chosen.map(v=>`${v.o.unit} leaves ${v.o.state==='standby'?'their original post':'their current assignment'}`).join('; ')}];
  });
}
