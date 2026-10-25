import type { Id, MapBundle, Officer } from '../../contracts.ts';
import { CELL_SIZE_M } from '../../contracts.ts';
import {FlowFields, UNREACHABLE} from '../../engine/src/flowfield.ts';

/** A brisk jog: officers are on foot, but they are not strolling to a surge. */
export const OFFICER_SPEED_MPS = 2.5;
export const OFFICER_REACH_CELLS = 10;

/** Where officers wait until a plan sends them somewhere. */
export interface PoliceStation {
  id: Id;
  name: string;
  /** A road cell: officers stand by on the street, ready to move. */
  cell: number;
}

/** Stations sit this far out from the bowl, in meters, so a dispatch is a visible walk in. */
const STATION_DISTANCE_M = [260, 520] as const;
const STATIONS = [
  { id: 'station-north', name: 'North police post', bearing: 0 },
  { id: 'station-southeast', name: 'Southeast police post', bearing: (2 * Math.PI) / 3 },
  { id: 'station-southwest', name: 'Southwest police post', bearing: (4 * Math.PI) / 3 },
];

/** The nearest mapped street name to a cell, within a walkable block. */
function streetNameNear(map: MapBundle, cell: number): string | undefined {
  const x = (cell % map.width) * CELL_SIZE_M + CELL_SIZE_M / 2;
  const y = Math.floor(cell / map.width) * CELL_SIZE_M + CELL_SIZE_M / 2;
  let best = Infinity;
  let name: string | undefined;
  for (const street of map.streets ?? []) {
    if (!street.name) continue;
    for (let i = 0; i < street.points.length; i += 2) {
      const d = Math.hypot(street.points[i]! - x, street.points[i + 1]! - y);
      if (d < best) {
        best = d;
        name = street.name;
      }
    }
  }
  return best <= 200 ? name : undefined;
}

/**
 * Police posts on the streets around the stadium, at even bearings from the
 * bowl. Each is the first road cell along its bearing between the two
 * distances that is well inside a road (road on all four sides), so officers
 * stand on the street rather than on a kerb against a building. A map with no
 * roads (the test map) has no stations, and officers start at the gates.
 */
export function policeStations(map: MapBundle): PoliceStation[] {
  const { width, height, cells } = map;
  const bowl = map.places.find((p) => p.kind === 'seating') ?? map.places[0];
  if (!bowl || bowl.cells.length === 0) return [];
  let sx = 0;
  let sy = 0;
  for (const cell of bowl.cells) {
    sx += cell % width;
    sy += Math.floor(cell / width);
  }
  const cx = sx / bowl.cells.length;
  const cy = sy / bowl.cells.length;
  const road = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && cells[y * width + x] === 'road';

  const out: PoliceStation[] = [];
  for (const station of STATIONS) {
    const dx = Math.sin(station.bearing);
    const dy = -Math.cos(station.bearing);
    for (let r = STATION_DISTANCE_M[0] / CELL_SIZE_M; r <= STATION_DISTANCE_M[1] / CELL_SIZE_M; r++) {
      const x = Math.round(cx + dx * r);
      const y = Math.round(cy + dy * r);
      if (road(x, y) && road(x + 1, y) && road(x - 1, y) && road(x, y + 1) && road(x, y - 1)) {
        const cell = y * width + x;
        const street = streetNameNear(map, cell);
        out.push({ id: station.id, name: street ? `OSU PD post - ${street}` : station.name, cell });
        break;
      }
    }
  }
  return out;
}

/**
 * Officers start at the police posts, shared out in turn, so sending them is a
 * walk in from the street that the commander can watch. Without stations they
 * start spread across the gates, which is where they stand before an incident.
 */
export function makeOfficers(map: MapBundle, count: number): Officer[] {
  const stations = policeStations(map);
  const posts =
    stations.length > 0
      ? stations.map((s) => s.cell)
      : map.places.filter((p) => p.kind === 'gate' || p.kind === 'concourse').map((p) => p.cells[0]!);
  if (posts.length === 0) throw new Error('map has nowhere to post officers');
  return Array.from({ length: count }, (_, i) => ({
    id: `off-${i + 1}`,
    unit: `OSU PD ${i + 1}`,
    cell: posts[i % posts.length]!,
    radiusCells: OFFICER_REACH_CELLS,
    speedMps: OFFICER_SPEED_MPS,
  }));
}

export interface PatrolBeat {name:string;waypoints:number[];loop:boolean}
const beatsCache=new WeakMap<MapBundle,PatrolBeat[]>();
/** Deterministic outdoor street loops; gate approaches are the road-free fallback. */
export function patrolBeats(map:MapBundle):PatrolBeat[] {
  const cached=beatsCache.get(map);if(cached)return cached;
  const fields=new FlowFields(map),stations=policeStations(map),beats:PatrolBeat[]=[];
  for(const station of stations) {
    const field=fields.toCell(station.cell),sx=station.cell%map.width,sy=Math.floor(station.cell/map.width);
    const waypoints=[station.cell];
    for(const [dx,dy] of [[0,-1],[1,0],[0,1],[-1,0]]) {
      const tx=sx+dx!*32,ty=sy+dy!*32;let best=-1,score=Infinity;
      for(let y=Math.max(0,sy-50);y<=Math.min(map.height-1,sy+50);y++)for(let x=Math.max(0,sx-50);x<=Math.min(map.width-1,sx+50);x++) {
        const cell=y*map.width+x;
        if(map.cells[cell]!=='road'||field.dist[cell]===UNREACHABLE||waypoints.includes(cell))continue;
        const d=Math.hypot(x-tx,y-ty);
        if(d<score){score=d;best=cell;}
      }
      if(best>=0)waypoints.push(best);
    }
    if(waypoints.length>1)beats.push({name:`${streetNameNear(map,station.cell)??station.name} patrol`,waypoints,loop:true});
  }
  const gates=map.places.filter(p=>p.kind==='gate').flatMap(p=>p.cells.slice(0,1));
  if(gates.length) {
    const field=fields.toCell(gates[0]!);
    const waypoints=gates.filter(c=>field.dist[c]!==UNREACHABLE);
    if(waypoints.length>1)beats.push({name:'Gate approach loop',waypoints,loop:true});
  }
  beatsCache.set(map,beats);return beats;
}
