import { describe, expect, it } from 'vitest';
import { diagonalZ, heightAt, personZ, vehicleDiagonal } from './depth.ts';

describe('close-up ground depth', () => {
  it('orders successive diagonals from back to front', () => {
    for (let d = 0; d < 1600; d++) expect(diagonalZ(d + 1)).toBeGreaterThan(diagonalZ(d));
  });

  it('keeps every point in a cell after its top and before the next diagonal', () => {
    for (const [u, v] of [[0, 0], [3, 5], [799, 799]]) {
      for (const dx of [0, 0.01, 1, 1.999999]) {
        for (const dy of [0, 0.01, 1, 1.999999]) {
          const z = personZ(u * 2 + dx, v * 2 + dy);
          expect(z).toBeGreaterThan(diagonalZ(u + v));
          expect(z).toBeLessThan(diagonalZ(u + v + 1));
        }
      }
    }
  });

  it('keeps a fan at the back corner above their tier and seated tint', () => {
    expect(personZ(6, 10)).toBeGreaterThan(diagonalZ(8) + 0.0008);
    expect(personZ(6.1, 10.1)).toBeLessThan(personZ(7.9, 11.9));
  });

  it.each([
    [0, 13], [Math.PI / 2, 13], [Math.PI, 13], [-Math.PI / 2, 13],
    [Math.PI / 4, 12], [-Math.PI / 4, 11], [3 * Math.PI / 4, 11],
  ])('uses the front-most footprint corner at heading %s', (heading, expected) => {
    expect(vehicleDiagonal(10, 10, heading, 8, 4)).toBe(expected);
    expect(vehicleDiagonal(10, 10, heading, 8, 4)).toBeGreaterThanOrEqual(10);
  });

  it('clamps an off-map footprint diagonal to zero', () => {
    expect(vehicleDiagonal(-10, -10, 0, 4, 2)).toBe(0);
  });

  it('looks up tier heights without wrapping off-map coordinates into another row', () => {
    const height = new Float32Array([0, 0, 0, 0, 15, 0, 0, 0, 0]);
    expect(heightAt(height, 3, 3, 2, 2)).toBe(15);
    expect(heightAt(height, 3, 3, 3.99, 3.99)).toBe(15);
    for (const [x, y] of [[0, 0], [-0.1, 2], [2, -0.1], [6, 0], [0, 6]]) {
      expect(heightAt(height, 3, 3, x, y)).toBe(0);
    }
  });
});
