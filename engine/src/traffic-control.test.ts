import {describe,expect,it} from 'vitest';
import {makeTestMap} from '../../world/src/test-map.ts';
import {makePopulation} from '../../brain/src/fan-types.ts';
import {testGateSurge} from '../../world/src/incidents.ts';
import {CLEAR_SKY} from '../../world/src/weather.ts';
import {TrafficModel} from './traffic.ts';
import {DensityField} from './density.ts';
import {DotStore} from './dots.ts';
describe('officer traffic points',()=>{
  it('meters entry on alternating axes, clears vehicles inside, and replays the same phase',()=>{
    const map={...makeTestMap(),width:31,height:31,cells:new Array(31*31).fill('road') as ReturnType<typeof makeTestMap>['cells'],places:[],closables:[]};
    const make=()=>new TrafficModel({map,config:{vehicles:1,seed:77,emergencyResponse:false},population:makePopulation(100,1),incident:testGateSurge(makeTestMap(),0),startAt:-10000,endAt:1000});
    const one=make(),two=make();
    const saved=one.capture() as {hx:Float32Array;hy:Float32Array;mode:Uint8Array;heading:Float32Array;speed:Float32Array};
    saved.hx[0]=21;saved.hy[0]=31;saved.mode[0]=4;saved.heading[0]=Math.PI;saved.speed[0]=5;
    one.restore(saved);two.restore(saved);
    const input={dt:1,weather:CLEAR_SKY,density:DensityField.forMap(map),dots:new DotStore(0),closed:new Set<string>(),controlPoints:[15*31+6]};
    one.step({...input,t:0});two.step({...input,t:8});
    expect(one.frame().x[0]).toBeLessThan(two.frame().x[0]!);
    expect(two.frame().speed[0]).toBe(0);
    const checkpoint=two.capture();two.step({...input,t:14});const frame=two.frame();
    expect(frame.speed[0]).toBeGreaterThan(0);
    two.restore(checkpoint);two.step({...input,t:14});expect(two.frame()).toEqual(frame);
  });
});
