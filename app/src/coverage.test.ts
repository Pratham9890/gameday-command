import {describe,expect,it} from 'vitest';
import {makeTestMap} from '../../world/src/test-map.ts';
import type {OfficerStatus} from '../../engine/src/edits.ts';
import {coverage} from './coverage.ts';
const unit:OfficerStatus={id:'a',unit:'Demo',cell:150,x:21,y:15,state:'standby',targetCell:-1,place:-1,homeCell:150,told:0,followed:0,etaS:null,radiusCells:2};
describe('geometric coverage',()=>{
  it('does not double-count overlapping units or include the bowl',()=>{
    const map=makeTestMap(),a=coverage(map,[unit],[]),b=coverage(map,[unit,{...unit,id:'b'}],[]);
    expect(a.coveredCells).toBeGreaterThan(0);expect(b.coveredCells).toBe(a.coveredCells);
    expect(a.outdoorCells).toBeLessThan(map.cells.length);expect(a.blockMeters).toBe(12);
    expect(a.grid.some(Boolean)).toBe(true);
  });
  it('reports no measured share for an empty domain',()=>{
    const map=makeTestMap();map.cells.fill('blocked');
    const c=coverage(map,[],[]);expect(c.outdoorShare).toBeNull();expect(c.hotspotShare).toBeNull();
  });
});
