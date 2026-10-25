/** Sparse per-actor paths between replay frames. Each sample is t,x,y,heading,speed.
 * Arrays transfer once per frame; stationary actors cost only their offset.
 * This is a rendering extension, never simulation state or a source of RNG draws.
 */
export interface MotionPath {
  from: number;
  to: number;
  offsets: Uint32Array;
  samples: Float32Array;
}

export interface MotionPose { x: number; y: number; h: number; speed: number }
const STRIDE = 5;

export class MotionRecorder {
  private t = 0;
  private from = 0;
  private previous: Float32Array | null = null;
  private paths = new Map<number, number[]>();

  capture(t: number, x: ArrayLike<number>, y: ArrayLike<number>, heading?: ArrayLike<number>, speed?: ArrayLike<number>): void {
    if (!this.previous || this.previous.length !== x.length * 4 || t <= this.t) {
      this.previous = new Float32Array(x.length * 4);
      this.paths.clear();
      this.from = t;
      for (let i = 0; i < x.length; i++) this.previous.set([x[i]!, y[i]!, heading?.[i] ?? 0, speed?.[i] ?? 0], i * 4);
      this.t = t;
      return;
    }
    for (let i = 0; i < x.length; i++) {
      const p = i * 4;
      const px = this.previous[p]!, py = this.previous[p + 1]!;
      if (px === x[i] && py === y[i] && !heading && !speed) {
        if (this.previous[p + 3] !== 0) {
          this.previous[p + 3] = 0;
          this.paths.get(i)?.push(t, px, py, this.previous[p + 2]!, 0);
        }
        continue;
      }
      const h = heading?.[i] ?? Math.atan2(y[i]! - py, x[i]! - px);
      const v = speed?.[i] ?? Math.hypot(x[i]! - px, y[i]! - py) / (t - this.t);
      if (px !== x[i] || py !== y[i] || (heading && this.previous[p + 2] !== h) || (speed && this.previous[p + 3] !== v)) {
        let path = this.paths.get(i);
        if (!path) { path = [this.t, px, py, this.previous[p + 2]!, this.previous[p + 3]!]; this.paths.set(i, path); }
        // Preserve time spent stationary instead of spreading the next move over it.
        if (path[path.length - STRIDE]! < this.t) path.push(this.t, px, py, this.previous[p + 2]!, this.previous[p + 3]!);
        path.push(t, x[i]!, y[i]!, h, v);
      }
      this.previous[p] = x[i]!;
      this.previous[p + 1] = y[i]!;
      this.previous[p + 2] = h;
      this.previous[p + 3] = v;
    }
    this.t = t;
  }

  take(): MotionPath {
    const count = (this.previous?.length ?? 0) / 4;
    const offsets = new Uint32Array(count + 1);
    let length = 0;
    for (let i = 0; i < count; i++) { offsets[i] = length; length += this.paths.get(i)?.length ?? 0; }
    offsets[count] = length;
    const samples = new Float32Array(length);
    for (const [i, path] of this.paths) samples.set(path, offsets[i]);
    const result = { from: this.from, to: this.t, offsets, samples };
    this.paths.clear();
    this.from = this.t;
    return result;
  }
}

/** Instant moves (spawn, admission, shelter and seek) snap; never draw a chord through the bowl. */
export function poseOnPath(path: MotionPath | undefined, actor: number, t: number, maxSpeed: number): MotionPose | null {
  if (!path || actor < 0 || actor + 1 >= path.offsets.length) return null;
  const start = path.offsets[actor]!, end = path.offsets[actor + 1]!;
  if (start === end) return null;
  const s = path.samples;
  let before = start;
  while (before + STRIDE < end && s[before + STRIDE]! <= t) before += STRIDE;
  const after = Math.min(before + STRIDE, end - STRIDE);
  const dt = s[after]! - s[before]!;
  const dx = s[after + 1]! - s[before + 1]!, dy = s[after + 2]! - s[before + 2]!;
  const snap = dt <= 0 || s[before + 1]! < 0 || s[after + 1]! < 0 || Math.hypot(dx, dy) > maxSpeed * dt;
  const a = snap ? (t >= s[after]! ? 1 : 0) : Math.max(0, Math.min(1, (t - s[before]!) / dt));
  let dh = s[after + 3]! - s[before + 3]!;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  return {x: s[before + 1]! + dx * a, y: s[before + 2]! + dy * a,
    h: s[before + 3]! + dh * a, speed: snap ? 0 : s[before + 4]! + (s[after + 4]! - s[before + 4]!) * a};
}
