import type { CellKind, SituationId } from '../../contracts.ts';
import { CELL_SIZE_M } from '../../contracts.ts';
import type { MovementModel, SimContext } from './sim.ts';

const SPAWNABLE: CellKind[] = ['parking', 'walk', 'concourse', 'stands'];

/**
 * Milestone 1 stand-in: dots orbit where they spawned.
 *
 * It exists so every other lane can be built and watched against real
 * TickFrames before flow fields land. It implements MovementModel, so the real
 * engine replaces it without touching the sim loop, the worker, or the app.
 */
export class CircleMovement implements MovementModel {
  private anchorX = new Float32Array(0);
  private anchorY = new Float32Array(0);
  private radius = new Float32Array(0);
  private phase = new Float32Array(0);
  private rate = new Float32Array(0);

  spawn(ctx: SimContext): void {
    const { map, dots, rng, population } = ctx;
    const spawnCells: number[] = [];
    for (let i = 0; i < map.cells.length; i++) {
      if (SPAWNABLE.includes(map.cells[i]!)) spawnCells.push(i);
    }
    if (spawnCells.length === 0) throw new Error('map has no spawnable cells');

    const gates = map.places.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'gate');
    const cumulative: number[] = [];
    let acc = 0;
    for (const type of population.types) {
      acc += type.share;
      cumulative.push(acc);
    }

    const n = dots.count;
    this.anchorX = new Float32Array(n);
    this.anchorY = new Float32Array(n);
    this.radius = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.rate = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const cell = spawnCells[rng.int(spawnCells.length)]!;
      const cx = ((cell % map.width) + rng.next()) * CELL_SIZE_M;
      const cy = (Math.floor(cell / map.width) + rng.next()) * CELL_SIZE_M;
      this.anchorX[i] = cx;
      this.anchorY[i] = cy;
      this.radius[i] = 1 + rng.next() * 4;
      this.phase[i] = rng.next() * Math.PI * 2;
      this.rate[i] = 0.15 + rng.next() * 0.25;
      dots.x[i] = cx;
      dots.y[i] = cy;

      const roll = rng.next();
      let typeIndex = cumulative.findIndex((c) => roll < c);
      if (typeIndex < 0) typeIndex = population.types.length - 1;
      dots.typeIndex[i] = typeIndex;
      dots.targetPlace[i] = gates.length > 0 ? gates[rng.int(gates.length)]!.i : -1;
      dots.setState(i, 'walking');
    }
  }

  step(ctx: SimContext, dt: number): void {
    const { dots, map } = ctx;
    const maxX = map.width * CELL_SIZE_M;
    const maxY = map.height * CELL_SIZE_M;
    for (let i = 0; i < dots.count; i++) {
      this.phase[i]! += this.rate[i]! * dt;
      const r = this.radius[i]!;
      const x = this.anchorX[i]! + Math.cos(this.phase[i]!) * r;
      const y = this.anchorY[i]! + Math.sin(this.phase[i]!) * r;
      dots.x[i] = Math.min(Math.max(x, 0), maxX - 0.01);
      dots.y[i] = Math.min(Math.max(y, 0), maxY - 0.01);
    }
  }

  onChoice(ctx: SimContext, dot: number, situation: SituationId, option: string): void {
    const { dots } = ctx;
    if (situation === 'lightning_shelter') {
      if (option === 'go_concourse') dots.setState(dot, 'sheltering');
      else if (option === 'go_car') dots.setState(dot, 'leaving');
      return;
    }
    if (situation === 'gate_jammed') {
      if (option === 'hold_place') dots.setState(dot, 'queued');
      else dots.setState(dot, 'walking');
    }
  }
}
