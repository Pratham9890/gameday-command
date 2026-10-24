import type { Incident, IncidentKind, MapBundle } from '../../contracts.ts';

export const INCIDENT_LABELS: Record<IncidentKind, string> = {
  lightning_delay: 'Lightning delay',
  gate_surge: 'Gate surge',
  suspicious_package: 'Suspicious package',
  medical: 'Medical',
  fight: 'Fight',
};

/** Places of a kind, in map order. Lets one playbook serve the test map and the stadium map. */
export function placesOfKind(map: MapBundle, kind: MapBundle['places'][number]['kind']) {
  return map.places.filter((p) => p.kind === kind);
}

/**
 * Grow a set of cells outward by `radius`, dropping walls and anything off the
 * map. An incident zone is the area people are standing in, not the doorway:
 * a gate surge is the crowd on the approach, which is what gets dangerous.
 */
export function expandCells(map: MapBundle, cells: readonly number[], radius: number): number[] {
  const out = new Set<number>();
  for (const cell of cells) {
    const cx = cell % map.width;
    const cy = Math.floor(cell / map.width);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
        const index = y * map.width + x;
        if (map.cells[index] === 'blocked') continue;
        out.add(index);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** The single fake incident Milestone 1 runs: a surge on the first gate, at kickoff. */
export function testGateSurge(map: MapBundle, at = 0): Incident {
  const gate = placesOfKind(map, 'gate')[0];
  if (!gate) throw new Error('map has no gate to surge');
  return {
    id: 'inc-test-surge',
    kind: 'gate_surge',
    at,
    placeId: gate.id,
    cells: expandCells(map, gate.cells, 3),
    safeCount: 0,
    note: `Late crowd piling into ${gate.name}`,
  };
}
