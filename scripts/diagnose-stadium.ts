import {readFileSync} from 'node:fs';
import {buildStadiumMap, loadExtract} from '../world/src/osm/stadium.ts';
import {FlowFields, UNREACHABLE} from '../engine/src/flowfield.ts';
import {TrafficModel, roadNetFor, trafficCapacity} from '../engine/src/traffic.ts';
import {makePopulation} from '../brain/src/fan-types.ts';
import {gateSurge} from '../world/src/incidents.ts';
import {CLEAR_SKY} from '../world/src/weather.ts';
import {DensityField} from '../engine/src/density.ts';
import {DotStore} from '../engine/src/dots.ts';
import {VEHICLE_STATES} from '../contracts.ts';
const saved = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : null;
const map = saved ? buildStadiumMap(saved.extract, saved.options) : buildStadiumMap(loadExtract());
const net = roadNetFor(map), fields = new FlowFields(map);
const gates = map.places.flatMap((p,i) => p.kind === 'gate' ? [fields.field(i,true)] : []);
let lots = 0, unreachable = 0;
for (let c=0;c<map.cells.length;c++) if(map.cells[c]==='parking') {lots++; if(!gates.some(f=>f.dist[c]!==UNREACHABLE)) unreachable++;}
console.log(JSON.stringify({map:map.name, gates:gates.length, lots, unreachable, entries:net.entries.length, stalls:net.stallX.length,
  connectedLots:net.stallsByLot.filter(s=>s.length>0).length, totalLots:net.lotCount}));
const traffic = new TrafficModel({map,config:{vehicles:process.argv.includes('--capacity')?trafficCapacity(map).vehicles:4500,seed:77,emergencyResponse:false},population:makePopulation(100000,20251023),incident:gateSurge(map,0),startAt:-3600,endAt:600});
const input={dt:1,weather:CLEAR_SKY,density:DensityField.forMap(map),dots:new DotStore(0),closed:new Set<string>()};
for (let t=-3600;t<=600;t++) {
  traffic.step({...input,t});
  if(t%600===0) {const counts:Record<string,number>={};for(const s of traffic.frame().state) counts[VEHICLE_STATES[s]!]=(counts[VEHICLE_STATES[s]!]??0)+1;console.log(JSON.stringify({t,counts,metrics:traffic.metrics()}));}
}
