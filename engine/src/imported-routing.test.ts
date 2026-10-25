import {describe,expect,it} from 'vitest';
import {makeTestMap} from '../../world/src/test-map.ts';
import {DIR_DX,DIR_DY,FlowFields} from './flowfield.ts';
import {roadJunctions} from './junctions.ts';
describe('imported ground route geometry',()=>{
  it('prefers a wider approach over a narrow shortcut and still respects walls',()=>{
    const W=30,H=30;
    const map={...makeTestMap(),width:W,height:H,cells:new Array(W*H).fill('walk') as ReturnType<typeof makeTestMap>['cells'],places:[]};
    for(let x=3;x<27;x++){map.cells[10*W+x]='blocked';map.cells[12*W+x]='blocked';}
    const start=11*W+2,target=11*W+28;
    expect(new FlowFields(map).toCell(target).dir[start]).toBe(1);
    const imported={...map,id:'osm-routing-test'},field=new FlowFields(imported).toCell(target);
    expect(field.dir[start]).not.toBe(1);
    let at=start,steps=0;
    while(at!==target && steps++<W*H) {
      const d=field.dir[at]!;expect(d).toBeGreaterThan(0);
      at+=DIR_DX[d]!+DIR_DY[d]!*W;expect(map.cells[at]).not.toBe('blocked');
    }
    expect(at).toBe(target);
  });
  it('recognizes a shared three-arm road junction rather than a road bend',()=>{
    const map=makeTestMap();map.cells.fill('road');
    map.streets=[{name:'Main',kind:'residential',points:[2,10,10,10,20,10]},
      {name:'Side',kind:'residential',points:[10,10,10,20]}];
    expect(roadJunctions(map)).toEqual([5*map.width+5]);
    const bend={...map,streets:[map.streets[0]!]};expect(roadJunctions(bend)).toEqual([]);
  });
});
