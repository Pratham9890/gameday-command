import { CELL_SIZE_M as C } from '../../contracts.ts';

/** Ground depth shared by a diagonal's building roofs and bowl tiers. */
export function diagonalZ(d: number): number {
  return ((d + 1) * C) / 2 - 0.001;
}

/** Sort a figure above its own cell, independently of the tier's height. */
export function personZ(mx: number, my: number): number {
  const u = Math.floor(mx / C);
  const v = Math.floor(my / C);
  // The local ground-depth tie-break spans less than 0.0001, never another diagonal.
  const within = (mx - u * C + my - v * C) / (2 * C);
  return diagonalZ(u + v) + 0.001 + within * 0.0001;
}

/** Return the diagonal touched by the footprint corner closest to the viewer. */
export function vehicleDiagonal(x: number, y: number, heading: number, lengthM: number, widthM: number): number {
  const fx = Math.cos(heading);
  const fy = Math.sin(heading);
  // Maximising each local axis is equivalent to taking max(cx + cy) over all four corners.
  const maxSum = x + y + Math.abs(fx + fy) * lengthM / 2 + Math.abs(fx - fy) * widthM / 2;
  return Math.max(0, Math.floor(maxSum / C));
}

/** Look up a tier height in metres, with off-map positions at ground level. */
export function heightAt(height: Float32Array, width: number, mapHeight: number, x: number, y: number): number {
  const u = Math.floor(x / C);
  const v = Math.floor(y / C);
  if (u < 0 || v < 0 || u >= width || v >= mapHeight) return 0;
  return height[v * width + u]!;
}
