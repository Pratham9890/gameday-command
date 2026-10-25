import {describe,it,expect} from 'vitest';
import {NearestCells} from './nearest-cells.ts';
describe('exact nearest eligible cell',()=>{
  it('matches ordered exhaustive search with changing occupancy and closures',()=>{
    const width=43,cells=Array.from({length:width*31},(_,i)=>i).filter(i=>i%7!==0).reverse(),search=new NearestCells(cells,width);
    for(let sample=0;sample<200;sample++) {
      const x=(sample*13.71)%60-8,y=(sample*7.19)%50-8,allowed=(c:number)=>(c+sample)%11>3;
      let best=-1,distance=Infinity;
      for(const c of cells){if(!allowed(c))continue;const dx=c%width+.5-x,dy=Math.floor(c/width)+.5-y,d=dx*dx+dy*dy;if(d<distance){distance=d;best=c;}}
      expect(search.nearest(x,y,allowed)).toBe(best);
    }
  });
  it('preserves list order at ties and returns no cell when all are full',()=>{
    const search=new NearestCells([2,0],10);
    expect(search.nearest(1.5,.5,()=>true)).toBe(2);
    expect(search.nearest(1.5,.5,()=>false)).toBe(-1);
    expect(new NearestCells([],10).nearest(0,0,()=>true)).toBe(-1);
  });
});
