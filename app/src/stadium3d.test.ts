import { expect, it } from 'vitest';
import { CONTRACT_VERSION, type MapBundle } from '../../contracts.ts';
import { buildBowl } from './stadium3d.ts';
import { personZ } from './depth.ts';

it('splits a bowl into increasing diagonals with seats in the same order', () => {
  const map: MapBundle = {
    version: CONTRACT_VERSION, id: 'ring', name: 'Ring', width: 5, height: 5,
    cells: Array.from({ length: 25 }, (_, c) => c % 5 > 0 && c % 5 < 4 && c >= 5 && c < 20 ? 'stands' : 'walk'),
    field: [12], places: [], closables: [], sources: [],
  };
  const bowl = buildBowl(map)!;
  expect(Array.isArray(bowl.shell)).toBe(true);
  expect(bowl.shell.map(({ d }) => d)).toEqual([2, 3, 4, 5, 6]);
  expect(Array.from(bowl.seats)).toEqual([6, 7, 11, 8, 16, 13, 17, 18]);
  for (let i = 1; i < bowl.shell.length; i++) {
    expect(bowl.shell[i]!.g.zIndex).toBeGreaterThan(bowl.shell[i - 1]!.g.zIndex);
  }
  for (const c of bowl.seats) {
    const u = c % map.width;
    const v = Math.floor(c / map.width);
    const tier = bowl.shell.find(({ d }) => d === u + v)!;
    expect(personZ(u * 2, v * 2)).toBeGreaterThan(tier.g.zIndex);
    const next = bowl.shell.find(({ d }) => d === u + v + 1);
    if (next) expect(personZ(u * 2 + 1.99, v * 2 + 1.99)).toBeLessThan(next.g.zIndex);
  }
  expect(bowl.height[12]).toBe(0);
  expect(bowl.height[6]).toBeGreaterThan(0);
  for (const { g } of bowl.shell) g.destroy();
  bowl.turf.destroy();
});
