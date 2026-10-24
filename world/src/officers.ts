import type { MapBundle, Officer } from '../../contracts.ts';

export const OFFICER_SPEED_MPS = 1.8;
export const OFFICER_REACH_CELLS = 8;

/** Officers start spread across the gates, which is where they stand before an incident. */
export function makeOfficers(map: MapBundle, count: number): Officer[] {
  const posts = map.places.filter((p) => p.kind === 'gate' || p.kind === 'concourse');
  if (posts.length === 0) throw new Error('map has nowhere to post officers');
  return Array.from({ length: count }, (_, i) => {
    const post = posts[i % posts.length]!;
    return {
      id: `off-${i + 1}`,
      unit: `OSU PD ${i + 1}`,
      cell: post.cells[0]!,
      radiusCells: OFFICER_REACH_CELLS,
      speedMps: OFFICER_SPEED_MPS,
    };
  });
}
