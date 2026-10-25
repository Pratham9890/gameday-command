import {describe,expect,it} from 'vitest';
import {makeTestMap} from '../../world/src/test-map.ts';
import type {OfficerStatus,SceneInfo} from '../../engine/src/edits.ts';
import type {PoliceHotspot} from './congestion.ts';
import {dispatchSuggestions,mergeHotspots,responseTargets} from './suggestions.ts';
const map=makeTestMap();
const spot=(score=10,x=12):PoliceHotspot=>({rank:1,kind:'crowd',level:'high',where:'Test queue',crowdedPeople:50,peakDensity:4,
  stoppedVehicles:0,slowVehicles:0,score,x0:x,y0:6,x1:x+1,y1:7,cx:(x+0.5)*2,cy:13});
const unit=(id:string,state:OfficerStatus['state']='standby',cell=240):OfficerStatus=>({id,unit:id,state,cell,x:cell%20*2,y:Math.floor(cell/20)*2,
  targetCell:-1,homeCell:240,place:-1,told:0,followed:0,etaS:null});
function scene(targets:ReturnType<typeof responseTargets>,officers=[unit('a'),unit('b')]):SceneInfo {
  return {t:100,officers,gates:[],closed:[],alerts:[],orders:[],responses:targets.map(t=>({cell:t.cell,units:officers.map((o,i)=>({id:o.id,etaS:10+i}))}))};
}
describe('dispatch suggestion rules',()=>{
  it('ranks severity and reserves each unit once',()=>{
    const targets=responseTargets(map,[spot(10,2),spot(20,15)]);
    const list=dispatchSuggestions(map,targets,scene(targets));
    expect(list).toHaveLength(2);expect(list[0]!.spot.score).toBe(20);
    expect(new Set(list.flatMap(s=>s.order.officerIds)).size).toBe(2);
  });
  it('prefers a reachable free unit over a nearer occupied one',()=>{
    const targets=responseTargets(map,[spot()]),s=scene(targets,[unit('busy','on_scene',300),unit('free')]);
    expect(dispatchSuggestions(map,targets,s)[0]!.order.officerIds).toEqual(['free']);
    s.responses![0]!.units.find(o=>o.id==='free')!.etaS=null;
    expect(dispatchSuggestions(map,targets,s)[0]!.order.officerIds).toEqual(['busy']);
  });
  it('keeps the last unit on a critical hotspot',()=>{
    const critical={...spot(40,2),level:'critical' as const,cx:5,cy:13};
    const targets=responseTargets(map,[critical,spot(20,17)]);
    const s=scene(targets,[unit('guard','on_scene',6*20+2),unit('free')]);
    expect(dispatchSuggestions(map,targets,s).flatMap(v=>v.order.officerIds)).not.toContain('guard');
  });
  it('respects dismissal time, expiry and a 25% escalation',()=>{
    const targets=responseTargets(map,[spot()]),s=scene(targets);
    s.orders=[{t:0,order:{type:'dismiss_suggestion',toCell:targets[0]!.cell,score:10}}];
    expect(dispatchSuggestions(map,targets,s)).toHaveLength(0);
    s.t=301;expect(dispatchSuggestions(map,targets,s)).toHaveLength(1);
    s.t=100;targets[0]!.spot.score=12.5;expect(dispatchSuggestions(map,targets,s)).toHaveLength(1);
  });
  it('merges neighboring hotspots transitively without mutating observations',()=>{
    const a=spot(10,2),b=spot(20,8),c=spot(30,14);
    const result=mergeHotspots([a,c,b]);
    expect(result).toHaveLength(1);expect(result[0]!.crowdedPeople).toBe(150);expect(a.crowdedPeople).toBe(50);
  });
  it('does not suggest a duplicate while a response is on its way',()=>{
    const targets=responseTargets(map,[spot()]),s=scene(targets);
    s.officers[0]!.mission={kind:'crowd',reason:'Test',targetCell:targets[0]!.cell,startedAt:0,arrivedAt:null,returnAfterS:180,phase:'responding'};
    expect(dispatchSuggestions(map,targets,s)).toHaveLength(0);
  });
  it('includes observed duration and a delivered suggestion timestamp',()=>{
    const targets=responseTargets(map,[spot()]),s=scene(targets);
    const list=dispatchSuggestions(map,targets,s,{durations:new Map([['Test queue',720]])});
    expect(list[0]!.why).toContain('seen for 12.0 min');
    expect(list[0]!.order.suggestionAt).toBe(100);
  });
  it('does not re-suggest a spot accepted less than five minutes ago',()=>{
    const targets=responseTargets(map,[spot()]),s=scene(targets);
    s.orders=[{t:0,order:{type:'respond',officerIds:['a'],toCell:targets[0]!.cell,kind:'crowd',reason:'Test',returnAfterS:60}}];
    expect(dispatchSuggestions(map,targets,s)).toHaveLength(0);
    s.t=301;expect(dispatchSuggestions(map,targets,s)).toHaveLength(1);
  });
});
