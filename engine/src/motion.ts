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
  private readonly intervalS: number;
  private t = 0;
  private from = 0;
  private previous: Float32Array | null = null;
  private tracks: (Float32Array | undefined)[] = [];
  private lengths = new Uint32Array();
  private active: number[] = [];

  constructor(intervalS = 1) {
    this.intervalS = Math.max(1, intervalS);
  }

  private append(i: number, t: number, x: number, y: number, h: number, speed: number): void {
    const length = this.lengths[i]!;
    let track = this.tracks[i];
    if (!track || length + STRIDE > track.length) {
      const grown = new Float32Array(Math.max(80, (track?.length ?? 0) * 2));
      if (track) grown.set(track);
      this.tracks[i] = track = grown;
    }
    if (length === 0) this.active.push(i);
    track[length] = t; track[length + 1] = x; track[length + 2] = y;
    track[length + 3] = h; track[length + 4] = speed;
    this.lengths[i] = length + STRIDE;
  }

  capture(t: number, x: ArrayLike<number>, y: ArrayLike<number>, heading?: ArrayLike<number>, speed?: ArrayLike<number>, force = false): void {
    if (this.previous?.length === x.length * 4 && t === this.t) return;
    if (this.previous?.length === x.length * 4 && t > this.t && t - this.t < this.intervalS && !force) return;
    if (!this.previous || this.previous.length !== x.length * 4 || t <= this.t) {
      this.previous = new Float32Array(x.length * 4);
      this.tracks = new Array(x.length);
      this.lengths = new Uint32Array(x.length);
      this.active.length = 0;
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
          if (this.lengths[i]) this.append(i, t, px, py, this.previous[p + 2]!, 0);
        }
        continue;
      }
      const h = heading?.[i] ?? 0;
      const dx = x[i]! - px, dy = y[i]! - py;
      const v = speed?.[i] ?? Math.sqrt(dx * dx + dy * dy) / (t - this.t);
      if (px !== x[i] || py !== y[i] || (heading && this.previous[p + 2] !== h) || (speed && this.previous[p + 3] !== v)) {
        if (!this.lengths[i]) this.append(i, this.t, px, py, this.previous[p + 2]!, this.previous[p + 3]!);
        const track = this.tracks[i]!;
        // Preserve time spent stationary instead of spreading the next move over it.
        if (track[this.lengths[i]! - STRIDE]! < this.t) this.append(i, this.t, px, py, this.previous[p + 2]!, this.previous[p + 3]!);
        this.append(i, t, x[i]!, y[i]!, h, v);
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
    for (let i = 0; i < count; i++) { offsets[i] = length; length += this.lengths[i]!; }
    offsets[count] = length;
    const samples = new Float32Array(length);
    for (const i of this.active) samples.set(this.tracks[i]!.subarray(0, this.lengths[i]), offsets[i]);
    const result = { from: this.from, to: this.t, offsets, samples };
    for (const i of this.active) this.lengths[i] = 0;
    this.active.length = 0;
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
  const snap = dt <= 0 || s[before + 1]! < 0 || s[after + 1]! < 0 || dx * dx + dy * dy > (maxSpeed * dt) ** 2;
  const a = snap ? (t >= s[after]! ? 1 : 0) : Math.max(0, Math.min(1, (t - s[before]!) / dt));
  let dh = s[after + 3]! - s[before + 3]!;
  if (dh > Math.PI || dh < -Math.PI) dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  return {x: s[before + 1]! + dx * a, y: s[before + 2]! + dy * a,
    h: s[before + 3]! + dh * a, speed: snap ? 0 : s[before + 4]! + (s[after + 4]! - s[before + 4]!) * a};
}
