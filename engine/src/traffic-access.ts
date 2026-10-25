import type {MapBundle} from '../../contracts.ts';
import {CELL_SIZE_M} from '../../contracts.ts';

/** Infer one shortest entrance per surface-lot component, up to 30 m over
 * walkable ground. Never drive through a building or turn an entire sidewalk
 * into a road. Only roads connected to the map edge seed these connectors.
 */
export function parkingConnectors(map: MapBundle, maxMeters = 30): Uint8Array {
  const {width: W,height: H,cells}=map, n=cells.length;
  const result=new Uint8Array(n), dist=new Int16Array(n).fill(-1), parent=new Int32Array(n).fill(-1), queue=new Int32Array(n);
  let head=0,tail=0;
  const neighbors=(c:number, visit:(next:number)=>void)=>{
    if(c%W>0)visit(c-1);if(c%W<W-1)visit(c+1);if(c>=W)visit(c-W);if(c<n-W)visit(c+W);
  };
  for(let c=0;c<n;c++) if(cells[c]==='road' && (c<W || c>=W*(H-1) || c%W===0 || c%W===W-1)) {dist[c]=0;queue[tail++]=c;}
  while(head<tail) {
    const c=queue[head++]!;
    neighbors(c,next=>{if(cells[next]==='road' && dist[next]<0){dist[next]=0;queue[tail++]=next;}});
  }
  head=0;
  while(head<tail) {
    const c=queue[head++]!;
    if(dist[c]!>=Math.floor(maxMeters/CELL_SIZE_M))continue;
    neighbors(c,next=>{if(cells[next]==='walk' && dist[next]<0){dist[next]=dist[c]!+1;parent[next]=c;queue[tail++]=next;}});
  }
  const seen=new Uint8Array(n), stack:number[]=[];
  for(let start=0;start<n;start++) {
    if(cells[start]!=='parking' || seen[start])continue;
    let best=-1,bestDist=Infinity;
    stack.push(start);seen[start]=1;
    while(stack.length) {
      const c=stack.pop()!;
      neighbors(c,next=>{
        if(cells[next]==='parking' && !seen[next]){seen[next]=1;stack.push(next);}
        if(dist[next]!>=0 && dist[next]!<bestDist){best=next;bestDist=dist[next]!;}
      });
    }
    while(best>=0 && cells[best]==='walk') {result[best]=1;best=parent[best]!;}
  }
  return result;
}
