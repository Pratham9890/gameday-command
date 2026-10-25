import {describe, expect, it} from 'vitest';
import {makeTestMap} from '../../world/src/test-map.ts';
import {testGateSurge} from '../../world/src/incidents.ts';
import {makeOfficers} from '../../world/src/officers.ts';
import {makePopulation} from '../../brain/src/fan-types.ts';
import {DECISION_DEFAULTS} from '../../brain/src/defaults.ts';
import {Simulation} from './sim.ts';
import {FlowMovement} from './movement-flow.ts';
import {FlowFields, UNREACHABLE} from './flowfield.ts';

function make() {
  const map=makeTestMap();
  // A wall between the starting post and street target, with a real detour.
  for(let y=4;y<10;y++)map.cells[y*map.width+8]='blocked';
  const officers=makeOfficers(map,1);officers[0]!.cell=6*map.width+3;
  const config={runId:'response',label:'A' as const,seed:42,startAt:-600,endAt:900,speed:1000,dangerDensity:4,mapId:map.id,
    officers,incident:testGateSurge(map,0),plan:{id:'none',name:'None',forIncident:'gate_surge' as const,officersAvailable:1,actions:[]}};
  return new Simulation({config,map,population:makePopulation(1000,42),defaults:DECISION_DEFAULTS,serverUrl:'',movement:new FlowMovement(),replay:{runId:'response',answers:[]}});
}
const step=async(sim:Simulation,n:number)=>{for(let i=0;i<n;i++)await sim.step();};

describe('live response missions',()=>{
  it('keeps vehicle-only barriers out of pedestrian routes and rewinds both closure kinds',async()=>{
    const sim=make(),before=sim.checkpoint(),cells=[243,244,245];
    sim.queueOrder({type:'barricade',closableId:'vehicle-test',closed:true,cells,blocks:'vehicles'});await sim.step();
    expect(sim.ctx.closed.has('vehicle-test')).toBe(false);expect(sim.trafficClosures().has('vehicle-test')).toBe(true);
    const fields=new FlowFields(sim.ctx.map),open=fields.toCell(247).dist.slice();fields.setClosed(sim.ctx.closed);expect(fields.toCell(247).dist).toEqual(open);
    sim.queueOrder({type:'barricade',closableId:'ped-test',closed:true,cells:[246],blocks:'pedestrians'});await sim.step();
    expect(sim.ctx.closed.has('ped-test')).toBe(true);expect(sim.trafficClosures().has('ped-test')).toBe(false);
    const closed=sim.checkpoint();sim.rewind(before);expect(sim.closedIds()).toEqual([]);
    await step(sim,2);expect(sim.closedIds()).toEqual(['ped-test','vehicle-test']);sim.rewind(closed);expect(sim.liveBarricades()).toHaveLength(2);
  });
  it('logs reports without changing the crowd and replays marker placement',async()=>{
    const sim=make(),control=make(),before=sim.checkpoint();
    sim.queueOrder({type:'officer_report',reportId:'report-1',officerId:'off-1',toCell:240,kind:'medical'});
    sim.queueOrder({type:'place_marker',marker:{id:'medical-1',cell:240,kind:'medical',name:'Medical tent',radiusCells:10}});
    await sim.step();await control.step();expect(sim.frame().x).toEqual(control.frame().x);expect(sim.markerStatus()).toHaveLength(1);
    sim.queueOrder({type:'remove_marker',id:'medical-1'});await sim.step();expect(sim.markerStatus()).toEqual([]);
    sim.rewind(before);await sim.step();expect(sim.markerStatus()[0]!.name).toBe('Medical tent');await sim.step();expect(sim.markerStatus()).toEqual([]);
  });

  it('patrols, interrupts, resumes and restores the waypoint on rewind',async()=>{
    const sim=make(),points=[123,134,214];
    sim.queueOrder({type:'patrol',officerIds:['off-1'],waypoints:points,loop:true,name:'Test streets'});
    await step(sim,35);expect(sim.officerStatus()[0]!.state).toBe('patrolling');
    const checkpoint=sim.checkpoint();await step(sim,30);const patrol=sim.officerStatus();
    sim.rewind(checkpoint);await step(sim,30);expect(sim.officerStatus()).toEqual(patrol);
    sim.queueOrder({type:'recall',officerIds:['off-1']});await sim.step();expect(sim.officerStatus()[0]!.patrol!.active).toBe(false);
    sim.queueOrder({type:'resume_patrol',officerIds:['off-1']});await sim.step();expect(sim.officerStatus()[0]!.state).toBe('patrolling');
  });
  it('replays additions and removals with the same ids after a seek',async()=>{
    const sim=make(),before=sim.checkpoint();
    sim.queueOrder({type:'add_officer',unit:'Synthetic unit',cell:240});await sim.step();
    const id=sim.ctx.officers[1]!.id;sim.queueOrder({type:'remove_officer',officerId:id});await sim.step();
    expect(sim.ctx.officers).toHaveLength(1);
    sim.rewind(before);await sim.step();expect(sim.ctx.officers[1]!.id).toBe(id);await sim.step();expect(sim.ctx.officers).toHaveLength(1);
  });
  it('uses a reachable detour to a street target and returns to the original post',async()=>{
    const sim=make(),home=sim.ctx.officers[0]!.cell,target=6*sim.ctx.map.width+14;
    sim.queueOrder({type:'respond',officerIds:['off-1'],toCell:target,kind:'crowd',reason:'Test congestion',returnAfterS:60});
    let working=false,returning=false;
    for(let i=0;i<200;i++) {
      await sim.step();const o=sim.officerStatus()[0]!;
      expect(sim.ctx.map.cells[o.cell]).not.toBe('blocked');
      expect(sim.ctx.map.cells[o.cell]).not.toBe('stands');
      working ||= o.mission?.phase==='working';returning ||= o.mission?.phase==='returning';
    }
    expect(working && returning).toBe(true);
    expect(sim.officerStatus()[0]).toMatchObject({state:'standby',cell:home});
  });
  it('restores mission progress, instructions and the return journey exactly',async()=>{
    const sim=make();
    sim.queueOrder({type:'respond',officerIds:['off-1'],toCell:134,kind:'crowd',reason:'Test',returnAfterS:120});
    await step(sim,35);const point=sim.checkpoint();
    await step(sim,80);const officers=sim.officerStatus(),frame=sim.frame(),card=sim.scorecard();
    sim.rewind(point);await step(sim,80);
    expect(sim.officerStatus()).toEqual(officers);expect(sim.frame().x).toEqual(frame.x);expect(sim.scorecard()).toEqual(card);
  });
  it('reports walking distance through a detour and rejects impossible posts',async()=>{
    const sim=make(),target=134;
    const eta=sim.responseTimes([target])[0]!.units[0]!.etaS!;
    const o=sim.ctx.officers[0]!,straight=Math.hypot(o.cell%20-target%20,Math.floor(o.cell/20)-Math.floor(target/20))*2/o.speedMps;
    expect(eta).toBeGreaterThan(straight);
    sim.queueOrder({type:'respond',officerIds:['off-1'],toCell:128,kind:'crowd',reason:'Inside wall',returnAfterS:60});
    await sim.step();expect(sim.officerStatus()[0]!.state).toBe('standby');
    const field=new FlowFields(sim.ctx.map).toCell(target);
    expect(field.dist[o.cell]).not.toBe(UNREACHABLE);
  });
  it('repeats live instructions and records fans following rather than just moving a marker',async()=>{
    const sim=make();
    sim.queueOrder({type:'respond',officerIds:['off-1'],toCell:11*20+14,kind:'crowd',reason:'Crowd on approach',returnAfterS:300});
    await step(sim,150);const first=sim.officerStatus()[0]!.told;
    await step(sim,100);const o=sim.officerStatus()[0]!;
    expect(o.told).toBeGreaterThan(0);expect(o.told).toBeGreaterThan(first);expect(o.followed).toBeGreaterThan(0);
  });
});
