import type { Id, MapBundle, SituationId } from '../../contracts.ts';
import { CELL_SIZE_M, DOT_GROUP_SIZE } from '../../contracts.ts';
import { FlowFields, DIR_DX, DIR_DY, UNREACHABLE } from './flowfield.ts';
import type { MovementModel, SimContext } from './sim.ts';

/**
 * Jam density in people per square meter. Above this nobody moves; the curve
 * below is linear down to a 5% crawl, which puts a visible slowdown right at the
 * 4 people/m² danger line the scorecard counts.
 */
export const RHO_JAM = 5.4;
const MIN_SPEED_FACTOR = 0.05;

export function densityFactor(peoplePerM2: number): number {
  return Math.max(MIN_SPEED_FACTOR, 1 - peoplePerM2 / RHO_JAM);
}

/** The real engine: flow fields, gate queues, and speed that falls with density. No AI. */
export class FlowMovement implements MovementModel {
  private fields!: FlowFields;
  private placeOfCell!: Int32Array;
  private gateIndexes: number[] = [];
  private gateDoor = new Map<number, Id>();
  private gateBudget!: Float32Array;
  private seatingIndex = -1;
  private shelterIndex = -1;
  private parkingIndex = -1;
  private exitIndexes: number[] = [];

  private spawnT!: Float32Array;
  private lotCell!: Int32Array;
  private homeGate!: Int32Array;
  private admitted!: Uint8Array;
  private closedKey = '';

  private cellOf(ctx: SimContext, i: number): number {
    const { dots, map } = ctx;
    const cx = (dots.x[i]! / CELL_SIZE_M) | 0;
    const cy = (dots.y[i]! / CELL_SIZE_M) | 0;
    if (cx < 0 || cy < 0 || cx >= map.width || cy >= map.height) return -1;
    return cy * map.width + cx;
  }

  private indexOfKind(map: MapBundle, kind: MapBundle['places'][number]['kind']): number {
    return map.places.findIndex((p) => p.kind === kind);
  }

  spawn(ctx: SimContext): void {
    const { map, dots, rng, population } = ctx;
    this.fields = new FlowFields(map);
    this.fields.setClosed(ctx.closed);

    this.placeOfCell = new Int32Array(map.width * map.height).fill(-1);
    map.places.forEach((place, index) => {
      for (const cell of place.cells) this.placeOfCell[cell] = index;
    });

    this.gateIndexes = map.places.map((p, i) => (p.kind === 'gate' ? i : -1)).filter((i) => i >= 0);
    this.gateBudget = new Float32Array(map.places.length);
    for (const gate of this.gateIndexes) {
      const place = map.places[gate]!;
      const door = map.closables.find((c) => c.cells.some((cell) => place.cells.includes(cell)));
      if (door) this.gateDoor.set(gate, door.id);
    }
    this.seatingIndex = this.indexOfKind(map, 'seating');
    this.shelterIndex = this.indexOfKind(map, 'shelter');
    if (this.shelterIndex < 0) this.shelterIndex = this.indexOfKind(map, 'concourse');
    this.parkingIndex = this.indexOfKind(map, 'parking');
    this.exitIndexes = map.places.map((p, i) => (p.kind === 'exit' ? i : -1)).filter((i) => i >= 0);
    if (this.exitIndexes.length === 0) this.exitIndexes = this.gateIndexes;

    // Built with a loop, not push(...spread): a stadium-sized lot is hundreds of
    // thousands of cells and spreading that many arguments overflows the stack.
    const lotCells: number[] = [];
    const lot = this.parkingIndex >= 0 ? map.places[this.parkingIndex] : undefined;
    if (lot) {
      for (const cell of lot.cells) if (this.fields.passable(cell)) lotCells.push(cell);
    }
    if (lotCells.length === 0) {
      for (let i = 0; i < map.cells.length; i++) if (this.fields.passable(i)) lotCells.push(i);
    }

    const cumulative: number[] = [];
    let acc = 0;
    for (const type of population.types) {
      acc += type.share;
      cumulative.push(acc);
    }

    const n = dots.count;
    this.spawnT = new Float32Array(n);
    this.lotCell = new Int32Array(n);
    this.homeGate = new Int32Array(n).fill(-1);
    this.admitted = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
      const roll = rng.next();
      let typeIndex = cumulative.findIndex((c) => roll < c);
      if (typeIndex < 0) typeIndex = population.types.length - 1;
      dots.typeIndex[i] = typeIndex;

      const type = population.types[typeIndex]!;
      const [from, to] = type.arrivalWindowMin;
      // Minutes before kickoff, so sim time is negative.
      this.spawnT[i] = -(from + (to - from) * rng.next()) * 60;

      const cell = lotCells[rng.int(lotCells.length)]!;
      this.lotCell[i] = cell;

      // Nearest gate by walking distance from where they parked, not straight line.
      let bestGate = this.gateIndexes[0] ?? -1;
      let bestDist = UNREACHABLE;
      for (const gate of this.gateIndexes) {
        const d = this.fields.field(gate).dist[cell]!;
        if (d < bestDist) {
          bestDist = d;
          bestGate = gate;
        }
      }
      this.homeGate[i] = bestGate;
      dots.targetPlace[i] = bestGate;

      // Off-map until they arrive: a fan still in their car is not crowd density.
      dots.x[i] = -1;
      dots.y[i] = -1;
      dots.setState(i, 'arriving');
    }
  }

  step(ctx: SimContext, dt: number): void {
    const { map, dots, density, population, rng } = ctx;

    const key = [...ctx.closed].sort().join(',');
    if (key !== this.closedKey) {
      this.closedKey = key;
      this.fields.setClosed(ctx.closed);
    }

    for (const gate of this.gateIndexes) {
      const perMin = map.places[gate]!.throughputPerMin ?? 0;
      this.gateBudget[gate]! += (perMin / 60 / DOT_GROUP_SIZE) * dt;
    }

    for (let i = 0; i < dots.count; i++) {
      const state = dots.stateOf(i);
      if (state === 'gone' || state === 'seated' || state === 'sheltering') continue;

      if (state === 'arriving') {
        if (ctx.t < this.spawnT[i]!) continue;
        const cell = this.lotCell[i]!;
        dots.x[i] = ((cell % map.width) + 0.15 + rng.next() * 0.7) * CELL_SIZE_M;
        dots.y[i] = (((cell / map.width) | 0) + 0.15 + rng.next() * 0.7) * CELL_SIZE_M;
        dots.setState(i, 'walking');
      }

      const cell = this.cellOf(ctx, i);
      if (cell < 0) continue;
      const target = dots.targetPlace[i]!;
      if (target < 0) continue;

      if (this.placeOfCell[cell] === target) {
        this.arrive(ctx, i, target);
        continue;
      }

      const field = this.fields.field(target);
      const dir = field.dir[cell]!;
      if (dir === 0) {
        // No route: a closed gate or a sealed street. They wait where they are.
        dots.setState(i, 'queued');
        continue;
      }

      const free = population.types[dots.typeIndex[i]!]?.walkSpeedMps ?? 1.2;
      const stride = free * densityFactor(density.peoplePerM2[cell]!) * dt;
      const dx = DIR_DX[dir]!;
      const dy = DIR_DY[dir]!;
      const norm = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1;
      const nx = dots.x[i]! + dx * norm * stride;
      const ny = dots.y[i]! + dy * norm * stride;

      const nCell = ((ny / CELL_SIZE_M) | 0) * map.width + ((nx / CELL_SIZE_M) | 0);
      if (nx < 0 || ny < 0 || nx >= map.width * CELL_SIZE_M || ny >= map.height * CELL_SIZE_M) continue;
      if (!this.fields.passable(nCell)) continue;
      dots.x[i] = nx;
      dots.y[i] = ny;
      dots.setState(i, 'walking');
    }
  }

  /** What reaching the target means depends on what the target is. */
  private arrive(ctx: SimContext, i: number, target: number): void {
    const { dots, map } = ctx;
    const kind = map.places[target]?.kind;

    if (kind === 'gate') {
      if (this.admitted[i] === 1) return;
      const door = this.gateDoor.get(target);
      const shut = door !== undefined && ctx.closed.has(door);
      if (!shut && this.gateBudget[target]! >= 1) {
        this.gateBudget[target]! -= 1;
        this.admitted[i] = 1;
        dots.targetPlace[i] = this.seatingIndex >= 0 ? this.seatingIndex : -1;
        dots.setState(i, 'walking');
      } else {
        dots.setState(i, 'queued');
      }
      return;
    }
    if (kind === 'seating') {
      dots.setState(i, 'seated');
      return;
    }
    if (kind === 'shelter' || kind === 'concourse') {
      dots.setState(i, 'sheltering');
      return;
    }
    if (kind === 'parking' || kind === 'exit') {
      dots.setState(i, 'gone');
      return;
    }
    dots.setState(i, 'walking');
  }

  /** Nearest place from a list, by walking distance from where the dot stands. */
  private nearest(ctx: SimContext, i: number, candidates: number[], exclude = -1): number {
    const cell = this.cellOf(ctx, i);
    if (cell < 0) return -1;
    let best = -1;
    let bestDist = UNREACHABLE;
    for (const index of candidates) {
      if (index === exclude) continue;
      const d = this.fields.field(index).dist[cell]!;
      if (d < bestDist) {
        bestDist = d;
        best = index;
      }
    }
    return best;
  }

  private retarget(ctx: SimContext, i: number, target: number): void {
    if (target < 0) return;
    ctx.dots.targetPlace[i] = target;
    ctx.dots.setState(i, 'walking');
  }

  onChoice(ctx: SimContext, dot: number, situation: SituationId, option: string): void {
    const { dots } = ctx;

    switch (situation) {
      case 'lightning_shelter':
        if (option === 'go_concourse') this.retarget(ctx, dot, this.shelterIndex);
        else if (option === 'go_car') this.retarget(ctx, dot, this.parkingIndex);
        return;

      case 'gate_jammed':
        if (option === 'try_other_gate') {
          this.retarget(ctx, dot, this.nearest(ctx, dot, this.gateIndexes, dots.targetPlace[dot]!));
        } else if (option === 'back_off') {
          this.retarget(ctx, dot, this.parkingIndex);
        } else {
          dots.setState(dot, 'queued');
        }
        return;

      case 'alert_received':
      case 'officer_instruction':
        // Only fans an alert actually reached, who choose to follow it, get redirected.
        if (option === 'follow') {
          const moved = ctx.redirects.get(dots.targetPlace[dot]!);
          if (moved !== undefined) this.retarget(ctx, dot, moved);
        }
        return;

      case 'street_closed':
        if (option === 'wait') dots.setState(dot, 'queued');
        return;

      case 'exit_route':
        if (option === 'nearest_exit') this.retarget(ctx, dot, this.nearest(ctx, dot, this.exitIndexes));
        else if (option === 'my_gate') this.retarget(ctx, dot, this.homeGate[dot]!);
        return;

      case 'leave_early':
        if (option === 'leave_now') this.retarget(ctx, dot, this.parkingIndex);
        return;

      case 'leave_tailgate':
        if (option === 'go_now' && dots.stateOf(dot) === 'arriving') this.spawnT[dot] = ctx.t;
        return;

      default:
        return;
    }
  }
}
