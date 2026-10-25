import {describe,expect,it} from 'vitest';
import {makeTestMap} from './test-map.ts';
import {patrolBeats} from './officers.ts';
import {FlowFields,UNREACHABLE} from '../../engine/src/flowfield.ts';
describe('deterministic outdoor beats',()=>{
  it('falls back to gate approaches on a road-free map and keeps every leg reachable',()=>{
    const map=makeTestMap(),original=JSON.stringify(map),beats=patrolBeats(map),fields=new FlowFields(map);
    expect(beats.length).toBeGreaterThan(0);expect(patrolBeats(map)).toEqual(beats);
    for(const beat of beats)for(let i=0;i<beat.waypoints.length;i++) {
      const from=beat.waypoints[i]!,to=beat.waypoints[(i+1)%beat.waypoints.length]!;
      expect(['road','walk','parking']).toContain(map.cells[from]);expect(fields.toCell(to).dist[from]).not.toBe(UNREACHABLE);
    }
    expect(JSON.stringify(map)).toBe(original);
  });
});
