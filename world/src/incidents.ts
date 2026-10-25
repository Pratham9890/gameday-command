import type { Incident, IncidentKind, MapBundle } from '../../contracts.ts';
import { CELL_SIZE_M } from '../../contracts.ts';

/**
 * People per square meter a zone has to come back down to before it counts as
 * clear: one person per five square meters, which is an area you can walk
 * straight across.
 *
 * A crowd never reaches zero while fans are still arriving, so safeCount: 0
 * reads as "never cleared" for every plan alike. But too generous a threshold
 * fails the same way from the other side — at two per square meter the north
 * gate zone was "clear" at its worst moment, having held only 855 people
 * against a threshold of 2,432, so every plan again scored the same. Measured
 * against the real occupancy curve, this threshold separates them: the plans
 * that disperse the crowd clear in seven to eight minutes, while closing the
 * hot gate never clears at all because the crowd piles up outside it.
 */
export const CLEAR_DENSITY = 0.2;

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

/** Kickoff plus three and a half hours: the gates let out. */
export const GAME_END_S = 3.5 * 3600;

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


/**
 * A lightning delay: everyone in the stands has to get out of the open.
 *
 * The zone is the seating deck, which is both who gets asked and what "clear"
 * means — the delay is over when the stands are empty. A plan's shelter order
 * raises for every fan on the map, inside or out; this is the part that is
 * measured.
 */
export function lightningDelay(map: MapBundle, at = 1800): Incident {
  const stands = placesOfKind(map, 'seating')[0];
  return {
    id: 'inc-lightning',
    kind: 'lightning_delay',
    at,
    placeId: stands?.id,
    cells: stands?.cells,
    safeCount: stands ? safeCountFor(stands.cells) : 0,
    note: 'Lightning within 8 miles. Everyone in the stands has to get out of the open.',
  };
}

/** The street a suspicious package would close: Woody Hayes Drive when mapped, else the longest. */
export function biggestStreet(map: MapBundle) {
  const streets = map.closables.filter((c) => c.id.startsWith('street-') || /lane|plaza/i.test(c.id));
  return (
    streets.find((c) => /Woody Hayes/i.test(c.name)) ??
    streets.sort((a, b) => b.cells.length - a.cells.length)[0]
  );
}

/** A suspicious package closing a street as the game lets out. */
export function suspiciousPackage(map: MapBundle, at = GAME_END_S): Incident {
  const street = biggestStreet(map) ?? map.closables[map.closables.length - 1];
  if (!street) throw new Error('map has nothing closable for a package incident');
  // A standoff cordon around a point on the street, not the whole street: the
  // package closes the road, but the danger zone is the crowd held back around
  // it. A whole-street zone could never be occupied, so no plan could clear.
  const point = street.cells[Math.floor(street.cells.length / 2)]!;
  const cells = expandCells(map, [point], 8);
  return {
    id: 'inc-package',
    kind: 'suspicious_package',
    at,
    cells,
    safeCount: safeCountFor(cells),
    note: `Unattended bag on ${street.name}. A 32 m cordon closes the street as the game lets out.`,
  };
}

/** The three incidents the commander can trigger. */
export function incidentsFor(map: MapBundle): Incident[] {
  return [gateSurge(map, 0), lightningDelay(map), suspiciousPackage(map)];
}

/** The sim window to run an incident in: the crowd still builds from kickoff minus 60. */
export function windowFor(incident: Incident): { startAt: number; endAt: number } {
  return { startAt: -3600, endAt: Math.max(900, incident.at + 1800) };
}
