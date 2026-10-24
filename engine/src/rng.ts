/**
 * sfc32 with a splitmix32 seed expansion. Chosen over Math.random because the
 * whole premise of the tool is that three plans run on the identical crowd:
 * same seed plus the same decision tape has to give the same run every time.
 * State is four uint32s, which is exactly what Snapshot.rngState carries.
 */
export class Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  constructor(seed: number) {
    let x = seed >>> 0;
    const nextSeed = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = nextSeed();
    this.b = nextSeed();
    this.c = nextSeed();
    this.d = nextSeed();
  }

  /** Next float in [0, 1). */
  next(): number {
    const t = (this.a + this.b) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.d = (this.d + 1) >>> 0;
    const r = (t + this.d) >>> 0;
    this.c = (this.c + r) >>> 0;
    return r / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  state(): number[] {
    return [this.a, this.b, this.c, this.d];
  }

  restore(state: number[]): void {
    this.a = state[0] ?? 0;
    this.b = state[1] ?? 0;
    this.c = state[2] ?? 0;
    this.d = state[3] ?? 0;
  }
}
