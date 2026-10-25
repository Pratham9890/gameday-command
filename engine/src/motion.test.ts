import {describe, expect, it} from 'vitest';
import {MotionRecorder, poseOnPath} from './motion.ts';

describe('motion paths between replay frames', () => {
  it('follows a corner and keeps stopped actors sparse', () => {
    const r = new MotionRecorder();
    r.capture(0, [0, 40], [0, 40]);
    r.capture(1, [2, 40], [0, 40]);
    r.capture(2, [2, 40], [2, 40]);
    const p = r.take();
    expect(poseOnPath(p, 0, 0.5, 3)).toMatchObject({x: 1, y: 0});
    expect(poseOnPath(p, 0, 1.5, 3)).toMatchObject({x: 2, y: 1});
    expect(poseOnPath(p, 1, 1.5, 3)).toBeNull();
    expect(p.offsets[1]).toBe(p.offsets[2]);
  });
  it('preserves a stop before restarting and between packets', () => {
    const r = new MotionRecorder();
    r.capture(0, [10], [10]);
    r.capture(1, [10], [10]);
    r.capture(2, [12], [10]);
    expect(poseOnPath(r.take(), 0, 0.5, 3)?.x).toBe(10);
    r.capture(3, [12], [10]);
    r.capture(4, [14], [10]);
    const p = r.take();
    expect(p.from).toBe(2);
    expect(poseOnPath(p, 0, 2.5, 3)?.x).toBe(12);
    expect(poseOnPath(p, 0, 3.5, 3)?.x).toBe(13);
  });
  it('snaps admission and spawn rather than animating across the bowl', () => {
    const r = new MotionRecorder();
    r.capture(0, [10, -1], [10, -1]);
    r.capture(1, [100, 20], [100, 20]);
    const p = r.take();
    expect(poseOnPath(p, 0, 0.5, 3)).toMatchObject({x: 10, y: 10});
    expect(poseOnPath(p, 0, 1, 3)).toMatchObject({x: 100, y: 100});
    expect(poseOnPath(p, 1, 0.5, 3)?.x).toBe(-1);
  });
  it('resets on a rewind or a roster change, without retaining a future path', () => {
    const r = new MotionRecorder();
    r.capture(0, [1], [1]); r.capture(1, [2], [1]);
    r.capture(0, [1], [1]);
    expect(r.take().samples.length).toBe(0);
    r.capture(1, [1, 3], [1, 3]);
    expect(r.take().samples.length).toBe(0);
  });
  it('interpolates heading across the wrap and speed on the same clock', () => {
    const r = new MotionRecorder();
    r.capture(0, [0], [0], [Math.PI - 0.1], [0]);
    r.capture(1, [1], [0], [-Math.PI + 0.1], [2]);
    const at = poseOnPath(r.take(), 0, 0.5, 3)!;
    expect(at.h).toBeCloseTo(Math.PI);
    expect(at.speed).toBeCloseTo(1);
  });
  it('transfers packets without detaching the recorder or changing earlier replay data', () => {
    const r = new MotionRecorder();
    r.capture(0, new Float32Array([10]), new Float32Array([10]));
    r.capture(1, new Float32Array([11]), new Float32Array([10]));
    const packet = r.take();
    const received = structuredClone(packet, {transfer: [packet.offsets.buffer, packet.samples.buffer]});
    expect(packet.samples.byteLength).toBe(0);
    r.capture(2, new Float32Array([11]), new Float32Array([11]));
    expect(poseOnPath(r.take(), 0, 1.5, 3)).toMatchObject({x: 11, y: 10.5});
    expect(poseOnPath(received, 0, 0.5, 3)).toMatchObject({x: 10.5, y: 10});
  });
  it('bounds crowd sampling cadence and can flush a final partial interval', () => {
    const r = new MotionRecorder(3);
    r.capture(0, [10], [10]);
    r.capture(1, [11], [10]);
    r.capture(2, [12], [10]);
    r.capture(3, [13], [10]);
    const p = r.take();
    expect(p.samples.length).toBe(10);
    expect(poseOnPath(p, 0, 1.5, 3)?.x).toBe(11.5);
    r.capture(4, [14], [10], undefined, undefined, true);
    r.capture(4, [14], [10], undefined, undefined, true);
    const partial = r.take();
    expect(partial.to).toBe(4);
    expect(poseOnPath(partial, 0, 3.5, 3)?.x).toBe(13.5);
  });
});
