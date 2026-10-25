import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {buildStadiumMap} from '../world/src/osm/stadium.ts';
import {makePopulation} from '../brain/src/fan-types.ts';
import {makeOfficers} from '../world/src/officers.ts';
import {gateSurge} from '../world/src/incidents.ts';
import {DECISION_DEFAULTS} from '../brain/src/defaults.ts';
import {Simulation} from '../engine/src/sim.ts';
import {FlowMovement} from '../engine/src/movement-flow.ts';
import {STATE_INDEX} from '../engine/src/dots.ts';
import {FlowFields} from '../engine/src/flowfield.ts';
import {policeHotspots} from '../app/src/congestion.ts';
import {makePlaceIndex} from '../app/src/heat.ts';
import {responseTargets,dispatchSuggestions} from '../app/src/suggestions.ts';
const saved=JSON.parse(readFileSync(process.argv[2]!,'utf8'));
const map=buildStadiumMap(saved.extract,saved.options);
const baselinePath=process.argv[3]&&!process.argv[3].startsWith('--')?process.argv[3]:undefined;
const Movement=baselinePath?(await import(pathToFileURL(resolve(baselinePath)).href)).FlowMovement:FlowMovement;
const config={runId:'import-diagnostic',label:'A' as const,seed:20251023,startAt:-3600,endAt:600,speed:1000,dangerDensity:4,mapId:map.id,
  incident:gateSurge(map,0),officers:makeOfficers(map,24),plan:{id:'none',name:'No actions',forIncident:'gate_surge' as const,officersAvailable:24,actions:[]}};
const sim=new Simulation({config,map,population:makePopulation(saved.options.capacity??90000,config.seed),defaults:DECISION_DEFAULTS,serverUrl:'',movement:new Movement(),replay:{runId:config.runId,answers:[]}});
let previousX:Float32Array|undefined,previousY:Float32Array|undefined;
const start=performance.now();
let dispatched=0;
while(!sim.done) {
  await sim.step();
  if(sim.ctx.t===0 && process.argv.includes('--responses')) {
    const hotspots=policeHotspots(map,sim.ctx.density.standingPerM2,undefined,makePlaceIndex(map),4);
    const targets=responseTargets(map,hotspots,config.incident,sim.ctx.t);
    const scene={t:sim.ctx.t,officers:sim.officerStatus(),gates:sim.gateStats(),closed:[],alerts:[],orders:sim.ordersLog(),responses:sim.responseTimes(targets.map(v=>v.cell))};
    for(const s of dispatchSuggestions(map,targets,scene)){sim.queueOrder(s.order);dispatched+=s.order.officerIds.length;}
  }
  if(sim.ctx.t===300) {previousX=sim.ctx.dots.x.slice();previousY=sim.ctx.dots.y.slice();}
}
const {dots}=sim.ctx;
let seated=0,queued=0,stationaryAwayFromGate=0;
const details:unknown[]=[],fields=new FlowFields(map);
const gates=map.places.filter(p=>p.kind==='gate').flatMap(p=>p.cells);
for(let i=0;i<dots.count;i++) {
  if(dots.state[i]===STATE_INDEX.seated)seated++;
  if(dots.state[i]===STATE_INDEX.queued)queued++;
  if(dots.x[i]!<0 || (dots.state[i]!==STATE_INDEX.queued && dots.state[i]!==STATE_INDEX.walking))continue;
  if(Math.hypot(dots.x[i]!-previousX![i]!,dots.y[i]!-previousY![i]!)>=1)continue;
  if(gates.every(c=>Math.hypot((c%map.width+0.5)*2-dots.x[i]!, (Math.floor(c/map.width)+0.5)*2-dots.y[i]!)>40)) {
    stationaryAwayFromGate++;
    if(details.length<3) {
      const x=Math.floor(dots.x[i]!/2),y=Math.floor(dots.y[i]!/2),cell=y*map.width+x;
      const field=fields.field(dots.targetPlace[i]!,true);
      const neighbors=[];
      for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) {
        const c=(y+dy)*map.width+x+dx;
        neighbors.push({dx,dy,kind:map.cells[c],density:sim.ctx.density.standingPerM2[c],cost:field.dist[c],dir:field.dir[c]});
      }
      details.push({dot:i,x:dots.x[i],y:dots.y[i],target:map.places[dots.targetPlace[i]!]?.name,cell,neighbors});
    }
  }
}
console.log(JSON.stringify({map:map.name,source:baselinePath??'current',dispatched,told:sim.officerStatus().reduce((n,o)=>n+o.told,0),followed:sim.officerStatus().reduce((n,o)=>n+o.followed,0),arrivals:sim.responseArrivals(),seatedPeople:seated*5,queuedPeople:queued*5,
  stationaryPeopleOverFiveMinutesAwayFromGate:stationaryAwayFromGate*5,msPerSimSecond:(performance.now()-start)/4200,gates:sim.gateStats(),scorecard:sim.scorecard(),details}));
