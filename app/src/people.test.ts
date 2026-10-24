import { describe, expect, it } from 'vitest';
import { FAN_TYPES } from '../../brain/src/fan-types.ts';
import { groupName, isoProject, isoUnproject, shirtColor } from './people.ts';

describe('close-up helpers', () => {
  it('unprojects a ground point back to where it came from', () => {
    for (const [mx, my] of [[0, 0], [12.5, 3], [1600, 0], [0, 1600], [733.2, 1021.7]] as const) {
      const { sx, sy } = isoProject(mx, my);
      const back = isoUnproject(sx, sy);
      expect(back.mx).toBeCloseTo(mx, 9);
      expect(back.my).toBeCloseTo(my, 9);
    }
  });

  it('lifts height straight up the screen', () => {
    expect(isoProject(10, 4, 3).sx).toBe(isoProject(10, 4).sx);
    expect(isoProject(10, 4, 3).sy).toBe(isoProject(10, 4).sy - 3);
  });

  it('gives each group the same name every time', () => {
    expect(groupName(1234)).toBe(groupName(1234));
    const names = new Set(Array.from({ length: 200 }, (_, i) => groupName(i)));
    expect(names.size).toBeGreaterThan(150);
  });

  it('gives every fan type its own shirt', () => {
    const shirts = new Set(FAN_TYPES.map((_, i) => shirtColor(FAN_TYPES, i)));
    expect(shirts.size).toBe(FAN_TYPES.length);
  });
});
