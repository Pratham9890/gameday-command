import {CELL_SIZE_M,type MapBundle} from '../../contracts.ts';
import {motorwayCells} from '../../engine/src/flowfield.ts';
import type {OfficerStatus} from '../../engine/src/edits.ts';
import {OFFICER_REACH_CELLS} from '../../world/src/officers.ts';
import type {PoliceHotspot} from './congestion.ts';
const terrain=new WeakMap<MapBundle,{mask:Uint8Array;count:number}>();
/** Current straight-line geometric reach, not safety or a prediction. */
export function coverage(map:MapBundle,officers:OfficerStatus[],hotspots:PoliceHotspot[]) {
  let base=terrain.get(map);
  if(!base) {
    const motorways=motorwayCells(map),mask=new Uint8Array(map.cells.length);let count=0;
    for(let c=0;c<mask.length;c++)if(['walk','road','parking'].includes(map.cells[c]!)&&!motorways[c]){mask[c]=1;count++;}
    base={mask,count};terrain.set(map,base);
  }
  const seen=new Uint8Array(map.cells.length),width=Math.ceil(map.width/6),grid=new Uint8Array(width*Math.ceil(map.height/6));
  let covered=0;
  for(const o of officers) {
    const r=o.radiusCells??OFFICER_REACH_CELLS,cx=o.x/CELL_SIZE_M,cy=o.y/CELL_SIZE_M;
    for(let y=Math.max(0,Math.floor(cy-r));y<=Math.min(map.height-1,Math.ceil(cy+r));y++)for(let x=Math.max(0,Math.floor(cx-r));x<=Math.min(map.width-1,Math.ceil(cx+r));x++) {
      const c=y*map.width+x;
      if(seen[c]||!base.mask[c]||(x+0.5-cx)**2+(y+0.5-cy)**2>r*r)continue;
      seen[c]=1;covered++;grid[Math.floor(y/6)*width+Math.floor(x/6)]=1;
    }
  }
  const reached=hotspots.filter(h=>officers.some(o=>Math.hypot(h.cx-o.x,h.cy-o.y)<=(o.radiusCells??OFFICER_REACH_CELLS)*CELL_SIZE_M)).length;
  return {grid,width,blockMeters:6*CELL_SIZE_M,coveredCells:covered,outdoorCells:base.count,
    outdoorShare:base.count?covered/base.count:null,hotspotShare:hotspots.length?reached/hotspots.length:null,
    uncoveredHotspots:hotspots.length-reached};
}
