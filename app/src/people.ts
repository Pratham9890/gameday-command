import type { FanType } from '../../contracts.ts';

/**
 * Shared pieces of the close-up view that have nothing to do with PixiJS, so
 * they can be tested under Node: the isometric projection, the colors, and the
 * names the inspector gives a group.
 */

/** Dot colour by DotState, in the contract's own order. The last state is 'gone'. */
export const STATE_RGB: [number, number, number][] = [
  [0x7a, 0xa2, 0xf7], // arriving
  [0xbb, 0x9a, 0xf7], // tailgating
  [0xe0, 0xaf, 0x68], // queued
  [0x9e, 0xce, 0x6a], // walking
  [0x7d, 0xcf, 0xff], // seated
  [0xf7, 0x76, 0x8e], // sheltering
  [0xc0, 0xca, 0xf5], // leaving
  [0x00, 0x00, 0x00], // gone, never drawn
];

export const rgbNum = ([r, g, b]: [number, number, number]) => (r << 16) | (g << 8) | b;
export const rgbCss = (rgb: [number, number, number]) => `#${rgbNum(rgb).toString(16).padStart(6, '0')}`;

/** Shirt colour per fan type, so a crowd reads as who it is made of. */
const SHIRTS: Record<string, number> = {
  'student-section': 0xd8343a,
  'alumni-family': 0xdadfe6,
  'season-regular': 0x98a1ab,
  tailgater: 0xf08c2e,
  'away-fan': 0x3d7bd9,
  'family-kids': 0x7fd16b,
  'mobility-limited': 0xc78bf0,
  'staff-vendor': 0xf5d547,
};
const SPARE_SHIRTS = [0xe6739f, 0x5fc7c0, 0xb5895a];

export function shirtColor(types: FanType[], index: number): number {
  const id = types[index]?.id;
  return (id ? SHIRTS[id] : undefined) ?? SPARE_SHIRTS[index % SPARE_SHIRTS.length]!;
}

export const SKIN_TONES = [0xf3d2b3, 0xe0ac82, 0xc68a5c, 0x9a6440, 0x6e4528];

/**
 * 2:1 isometric. Screen x runs along (x − y) and screen y along (x + y) / 2, in
 * meters, with height subtracted from screen y. Increasing x walks down-right
 * and increasing y down-left, so the viewer stands off the south-east corner and
 * sees the south and east faces of a building.
 */
export function isoProject(mx: number, my: number, h = 0): { sx: number; sy: number } {
  return { sx: mx - my, sy: (mx + my) / 2 - h };
}

/** The inverse, for a point on the ground. */
export function isoUnproject(sx: number, sy: number): { mx: number; my: number } {
  return { mx: sy + sx / 2, my: sy - sx / 2 };
}

const FIRST = [
  'Avery', 'Jordan', 'Riley', 'Morgan', 'Casey', 'Taylor', 'Jamie', 'Quinn', 'Rowan', 'Skyler',
  'Dakota', 'Emerson', 'Hayden', 'Kendall', 'Logan', 'Parker', 'Reese', 'Sage', 'Drew', 'Ellis',
  'Priya', 'Mateo', 'Aisha', 'Kenji', 'Noor', 'Diego', 'Mei', 'Omar', 'Lena', 'Tariq',
];
const LAST = [
  'Buckley', 'Hayes', 'Brutus', 'Woody', 'Archer', 'Griffin', 'Tressel', 'Lantern', 'Mirror', 'Olentangy',
  'Nakamura', 'Okafor', 'Patel', 'Romero', 'Schmidt', 'Kowalski', 'Nguyen', 'Haddad', 'Larsen', 'Moreau',
];

/** A stable name for a group, so the person you clicked is someone you can find again. */
export function groupName(dot: number): string {
  const h = Math.imul(dot + 1, 2654435761) >>> 0;
  return `${FIRST[h % FIRST.length]} ${LAST[(h >>> 8) % LAST.length]}`;
}

export function skinOf(dot: number): number {
  return SKIN_TONES[(Math.imul(dot + 7, 40503) >>> 4) % SKIN_TONES.length]!;
}
