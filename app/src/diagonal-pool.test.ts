import { expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { DiagonalPool } from './diagonal-pool.ts';

it('batches a diagonal and reuses attached graphics when occupied diagonals change', () => {
  const parent = new Container();
  const pool = new DiagonalPool(parent, 0.0008);
  const first = pool.get(3);
  first.rect(0, 0, 2, 2).fill(0xffffff);
  expect(pool.get(3)).toBe(first);
  const second = pool.get(5);
  expect(parent.children).toHaveLength(2);
  expect(first.zIndex).toBeLessThan(second.zIndex);
  pool.clear();
  expect(first.visible).toBe(false);
  expect(second.visible).toBe(false);
  expect(first.context.instructions).toHaveLength(0);
  const reused = pool.get(7);
  expect([first, second]).toContain(reused);
  expect(reused.visible).toBe(true);
  expect(reused.zIndex).toBeCloseTo(7.9998, 8);
  expect(parent.children).toHaveLength(2);
  pool.clear();
  expect(pool.get(7)).toBe(reused);
  parent.destroy({ children: true });
});
