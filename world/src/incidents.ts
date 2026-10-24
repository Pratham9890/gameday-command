import type { Incident, IncidentKind, MapBundle } from '../../contracts.ts';
import { CELL_SIZE_M } from '../../contracts.ts';

/**
 * People per square meter a zone has to come back down to before it counts as
 * clear. A crowd never reaches zero while fans are still arriving, so
 * safeCount: 0 would read as "never cleared" for every plan alike and the
 * scorecard could not tell them apart. Two per square meter is a crowd you can
 * walk through.
 */
export const CLEAR_DENSITY = 2;

/** How many people a zone holds at the comfortable density. */
export function safeCountFor(cells: readonly number[]): number {
  return Math.round(cells.length * CELL_SIZE_M * CELL_SIZE_M * CLEAR_DENSITY);
}

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

/** The gate nearest due north, which is where a late crowd piles in. */
export function northGate(map: MapBundle) {
  const gates = placesOfKind(map, 'gate');
  return gates.find((g) => /\(N\)/.test(g.name)) ?? gates[0];
}

/** A surge on the north gate at kickoff, on whichever map is loaded. */
export function gateSurge(map: MapBundle, at = 0): Incident {
  const gate = northGate(map);
  if (!gate) throw new Error('map has no gate to surge');
  const cells = expandCells(map, gate.cells, 6);
  return {
    id: 'inc-gate-surge',
    kind: 'gate_surge',
    at,
    placeId: gate.id,
    cells,
    safeCount: safeCountFor(cells),
    note: `Late crowd piling into ${gate.name} at kickoff`,
  };
}

/** The single fake incident Milestone 1 runs: a surge on the first gate, at kickoff. */
export function testGateSurge(map: MapBundle, at = 0): Incident {
  const gate = placesOfKind(map, 'gate')[0];
  if (!gate) throw new Error('map has no gate to surge');
  const cells = expandCells(map, gate.cells, 3);
  return {
    id: 'inc-test-surge',
    kind: 'gate_surge',
    at,
    placeId: gate.id,
    cells,
    safeCount: safeCountFor(cells),
    note: `Late crowd piling into ${gate.name}`,
  };
}
