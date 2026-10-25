import {describe, expect, it} from 'vitest';
import type {TickFrame} from '../../contracts.ts';
import type {SceneInfo} from '../../engine/src/edits.ts';
import {MotionRecorder} from '../../engine/src/motion.ts';
import {blend} from './motion-view.ts';

function fixture() {
  const recorder = new MotionRecorder();
  recorder.capture(0, [10], [10], [0], [2]);
  recorder.capture(1, [12], [10], [0], [2]);
  recorder.capture(2, [12], [12], [Math.PI / 2], [0]);
  const path = recorder.take();
  const frame: TickFrame = {runId: 'test', t: 2, x: new Float32Array([12]), y: new Float32Array([12]),
    state: new Uint8Array([1]), officerCells: new Int32Array(),
    vehicles: {x: new Float32Array([12]), y: new Float32Array([12]), heading: new Float32Array([Math.PI / 2]),
      speed: new Float32Array([0]), state: new Uint8Array([1]), kind: new Uint8Array([0]), waitedS: new Float32Array([0])}};
  const scene: SceneInfo = {t: 2, officers: [], gates: [], closed: [], alerts: [],
    motion: {people: path, vehicles: path, officers: new MotionRecorder().take(), officerIds: []}};
  const prev = {frame: {...frame, t: 0, x: new Float32Array([10]), y: new Float32Array([10])}};
  return {frame, prev, scene};
}

describe('plan view path interpolation', () => {
  it('keeps both people and vehicles on the recorded corner, and uses sampled speed', () => {
    const {frame, prev, scene} = fixture();
    const d = blend(prev, {frame}, 0.75, undefined, scene);
    expect([d.x[0], d.y[0], d.vx![0], d.vy![0]]).toEqual([12, 11, 12, 11]);
    expect(d.vs![0]).toBe(1);
    expect(d.vh![0]).toBeCloseTo(Math.PI / 4);
    expect(frame.x[0]).toBe(12);
    expect(frame.y[0]).toBe(12);
  });
  it('snaps replays and stale or missing scene data without mutating recorded frames', () => {
    const {frame, prev, scene} = fixture();
    for (const [p, s] of [[null, scene], [prev, undefined], [prev, {...scene, t: 3}]] as const) {
      const d = blend(p, {frame}, 0.5, undefined, s);
      expect(d.x).toBe(frame.x);
      expect(d.vx).toBe(frame.vehicles!.x);
    }
  });
  it('reuses draw buffers without using the replay frame arrays as scratch space', () => {
    const {frame, prev, scene} = fixture();
    const first = blend(prev, {frame}, 0.25, undefined, scene);
    const second = blend(prev, {frame}, 0.75, first, scene);
    expect(second.x).toBe(first.x);
    expect(second.vx).toBe(first.vx);
    expect(second.x).not.toBe(frame.x);
    expect(frame.vehicles!.y[0]).toBe(12);
  });
});
