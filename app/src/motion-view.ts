import type {VehicleFrame} from '../../contracts.ts';
import type {SceneInfo} from '../../engine/src/edits.ts';
import {poseOnPath} from '../../engine/src/motion.ts';
import type {RunSnapshotView} from './useRun.ts';

export interface Drawn {
  x: Float32Array;
  y: Float32Array;
  state: Uint8Array;
  vehicles?: VehicleFrame;
  vx?: Float32Array;
  vy?: Float32Array;
  vh?: Float32Array;
  vs?: Float32Array;
}

/** Both renderers use recorded per-second poses; absent paths snap, never cut a corner. */
export function blend(prev: RunSnapshotView | null, latest: RunSnapshotView, alpha: number, into: Drawn | undefined, scene?: SceneInfo | null): Drawn {
  const f = latest.frame;
  if (!prev || alpha >= 1 || prev.frame.x.length !== f.x.length || scene?.t !== f.t || !scene.motion) {
    return {x: f.x, y: f.y, state: f.state, vehicles: f.vehicles, vx: f.vehicles?.x,
      vy: f.vehicles?.y, vh: f.vehicles?.heading, vs: f.vehicles?.speed};
  }
  const n = f.x.length;
  const x = into && into.x !== f.x && into.x.length === n ? into.x : new Float32Array(n);
  const y = into && into.y !== f.y && into.y.length === n ? into.y : new Float32Array(n);
  const motion = scene.motion;
  const t = motion.people.from + (motion.people.to - motion.people.from) * alpha;
  for (let i = 0; i < n; i++) {
    const at = poseOnPath(motion.people, i, t, 3);
    x[i] = at?.x ?? f.x[i]!;
    y[i] = at?.y ?? f.y[i]!;
  }
  const out: Drawn = {x, y, state: f.state, vehicles: f.vehicles};
  const v = f.vehicles;
  if (v) {
    const m = v.x.length;
    const reuse = (a: Float32Array | undefined, latestArray: Float32Array) => a && a !== latestArray && a.length === m ? a : new Float32Array(m);
    const vx = reuse(into?.vx, v.x), vy = reuse(into?.vy, v.y), vh = reuse(into?.vh, v.heading), vs = reuse(into?.vs, v.speed);
    const vt = motion.vehicles.from + (motion.vehicles.to - motion.vehicles.from) * alpha;
    for (let i = 0; i < m; i++) {
      const at = poseOnPath(motion.vehicles, i, vt, 40);
      vx[i] = at?.x ?? v.x[i]!; vy[i] = at?.y ?? v.y[i]!;
      vh[i] = at?.h ?? v.heading[i]!; vs[i] = at?.speed ?? v.speed[i]!;
    }
    Object.assign(out, {vx, vy, vh, vs});
  }
  return out;
}
