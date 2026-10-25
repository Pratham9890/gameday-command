import type {MapBundle} from '../../contracts.ts';
import {CELL_SIZE_M} from '../../contracts.ts';
const cache=new WeakMap<MapBundle,number[]>();
const footways=new Set(['footway','pedestrian','path','steps','cycleway','bridleway']);
/** Shared street vertices with at least three distinct arms, on the road grid. */
export function roadJunctions(map:MapBundle):number[] {
  const existing=cache.get(map);if(existing)return existing;
  const arms=new Map<number,Set<number>>();
  for(const street of map.streets??[]) {
    if(footways.has(street.kind))continue;
    const p=street.points;
    for(let i=0;i+1<p.length;i+=2) {
      const x=Math.floor(p[i]!/CELL_SIZE_M),y=Math.floor(p[i+1]!/CELL_SIZE_M),cell=y*map.width+x;
      if(x<0||y<0||x>=map.width||y>=map.height||map.cells[cell]!=='road')continue;
      let directions=arms.get(cell);if(!directions){directions=new Set();arms.set(cell,directions);}
      for(const j of [i-2,i+2])if(j>=0&&j+1<p.length) {
        const dx=p[j]!-p[i]!,dy=p[j+1]!-p[i+1]!;
        if(dx||dy)directions.add((Math.round(Math.atan2(dy,dx)/(Math.PI/4))+8)%8);
      }
    }
  }
  const result=[...arms].filter(([,a])=>a.size>=3).map(([cell])=>cell).sort((a,b)=>a-b);
  cache.set(map,result);return result;
}
