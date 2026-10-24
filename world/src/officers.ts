import type { Id, MapBundle, Officer } from '../../contracts.ts';
import { CELL_SIZE_M } from '../../contracts.ts';

/** A brisk jog: officers are on foot, but they are not strolling to a surge. */
export const OFFICER_SPEED_MPS = 2.5;
export const OFFICER_REACH_CELLS = 10;

/** Where officers wait until a plan sends them somewhere. */
export interface PoliceStation {
  id: Id;
  name: string;
  /** A road cell: officers stand by on the street, ready to move. */
  cell: number;
}

/** Stations sit this far out from the bowl, in meters, so a dispatch is a visible walk in. */
const STATION_DISTANCE_M = [260, 520] as const;
const STATIONS = [
  { id: 'station-north', name: 'North police post', bearing: 0 },
  { id: 'station-southeast', name: 'Southeast police post', bearing: (2 * Math.PI) / 3 },
  { id: 'station-southwest', name: 'Southwest police post', bearing: (4 * Math.PI) / 3 },
];

/**
 * Police posts on the streets around the stadium, at even bearings from the
 * bowl. Each is the first road cell along its bearing between the two
 * distances that is well inside a road (road on all four sides), so officers
 * stand on the street rather than on a kerb against a building. A map with no
 * roads (the test map) has no stations, and officers start at the gates.
 */
export function policeStations(map: MapBundle): PoliceStation[] {
  const { width, height, cells } = map;
  const bowl = map.places.find((p) => p.kind === 'seating') ?? map.places[0];
  if (!bowl || bowl.cells.length === 0) return [];
  let sx = 0;
  let sy = 0;
  for (const cell of bowl.cells) {
    sx += cell % width;
    sy += Math.floor(cell / width);
  }
  const cx = sx / bowl.cells.length;
  const cy = sy / bowl.cells.length;
  const road = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && cells[y * width + x] === 'road';

  const out: PoliceStation[] = [];
  for (const station of STATIONS) {
    const dx = Math.sin(station.bearing);
    const dy = -Math.cos(station.bearing);
    for (let r = STATION_DISTANCE_M[0] / CELL_SIZE_M; r <= STATION_DISTANCE_M[1] / CELL_SIZE_M; r++) {
      const x = Math.round(cx + dx * r);
      const y = Math.round(cy + dy * r);
      if (road(x, y) && road(x + 1, y) && road(x - 1, y) && road(x, y + 1) && road(x, y - 1)) {
        out.push({ id: station.id, name: station.name, cell: y * width + x });
        break;
      }
    }
  }
  return out;
}

/**
 * Officers start at the police posts, shared out in turn, so sending them is a
 * walk in from the street that the commander can watch. Without stations they
 * start spread across the gates, which is where they stand before an incident.
 */
export function makeOfficers(map: MapBundle, count: number): Officer[] {
  const stations = policeStations(map);
  const posts =
    stations.length > 0
      ? stations.map((s) => s.cell)
      : map.places.filter((p) => p.kind === 'gate' || p.kind === 'concourse').map((p) => p.cells[0]!);
  if (posts.length === 0) throw new Error('map has nowhere to post officers');
  return Array.from({ length: count }, (_, i) => ({
    id: `off-${i + 1}`,
    unit: `OSU PD ${i + 1}`,
    cell: posts[i % posts.length]!,
    radiusCells: OFFICER_REACH_CELLS,
    speedMps: OFFICER_SPEED_MPS,
  }));
}
