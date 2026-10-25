import { Container, Graphics } from 'pixi.js';
import { diagonalZ } from './depth.ts';

/** Reusable diagonal batches that stay attached to the depth-sorted container. */
export class DiagonalPool {
  private parent: Container;
  private offset: number;
  private pool: Graphics[] = [];
  private active = new Map<number, Graphics>();

  constructor(parent: Container, offset: number) {
    this.parent = parent;
    this.offset = offset;
  }

  /** Clear only last frame's batches; unused graphics remain attached and hidden. */
  clear(): void {
    for (const g of this.active.values()) {
      g.clear();
      g.visible = false;
    }
    this.active.clear();
  }

  /** Get the shared batch for a diagonal, growing only beyond peak occupancy. */
  get(d: number): Graphics {
    const existing = this.active.get(d);
    if (existing) return existing;
    let g = this.pool[this.active.size];
    if (!g) {
      g = new Graphics();
      this.pool.push(g);
      this.parent.addChild(g);
    }
    g.zIndex = diagonalZ(d) + this.offset;
    g.visible = true;
    this.active.set(d, g);
    return g;
  }
}
