import {describe,expect,it} from 'vitest';
import {makeTestMap} from '../../world/src/test-map.ts';
import {parkingConnectors} from './traffic-access.ts';
import {trafficCapacity} from './traffic.ts';
describe('surface parking entrances',()=>{
  it('connects a lot across a gap without making the entire sidewalk drivable',()=>{
    const m=makeTestMap();m.cells.fill('walk');m.places=[];
    for(let y=0;y<m.height;y++)m.cells[y*m.width]='road';
    for(let y=5;y<10;y++)for(let x=6;x<12;x++)m.cells[y*m.width+x]='parking';
    const a=parkingConnectors(m);
    expect([...a].reduce((s,v)=>s+v,0)).toBe(5);
    expect(a.some((v,c)=>!!v && m.cells[c]!=='walk')).toBe(false);
    expect(parkingConnectors(m)).toEqual(a);
  });
  it('does not connect through buildings or to an isolated road island',()=>{
    const m=makeTestMap();m.cells.fill('blocked');m.places=[];
    m.cells[105]='road';m.cells[106]='walk';m.cells[107]='parking';
    expect(parkingConnectors(m).some(Boolean)).toBe(false);
  });
  it('does not invent parking capacity when no road reaches a stall',()=>{
    const capacity=trafficCapacity(makeTestMap());
    expect(capacity.vehicles).toBe(0);expect(capacity.stalls).toBe(0);
  });
});
