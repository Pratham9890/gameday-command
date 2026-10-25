import type { MapBundle } from '../../contracts.ts';
import { CELL_SIZE_M } from '../../contracts.ts';
import type { OfficerStatus } from '../../engine/src/edits.ts';

const AREA = CELL_SIZE_M * CELL_SIZE_M;

export interface DensityLike {
  peoplePerM2: Float32Array;
  /** People on their feet; seated fans are safe and must not read as a queue. */
  standingPerM2?: Float32Array;
}

export interface ZoneRow {
  id: string;
  name: string;
  people: number;
  peak: number;
  trendPerMin: number;
  etaMin: number | null;
}

export interface ZoneSample {
  people: number;
  peak: number;
}

const placesOf = (map: MapBundle, kinds: string[]) => map.places.filter((p) => kinds.includes(p.kind));

/** People, peak density, 15-minute trend and time-to-threshold for each named area. */
export function zoneRows(
  map: MapBundle,
  density: DensityLike | undefined,
  previous: Record<string, ZoneSample> | undefined,
  threshold = 4,
  minutes = 15,
): ZoneRow[] {
  if (!density) return [];
  const grid = density.standingPerM2 ?? density.peoplePerM2;
  const rows: ZoneRow[] = [];
  for (const place of placesOf(map, ['gate', 'concourse', 'parking', 'tailgate'])) {
    let people = 0;
    let peak = 0;
    for (const cell of place.cells) {
      const v = grid[cell] ?? 0;
      people += v * AREA;
      if (v > peak) peak = v;
    }
    const before = previous?.[place.id];
    const trend = before ? (people - before.people) / minutes : 0;
    const peakRate = before ? (peak - before.peak) / minutes : 0;
    const eta =
      peak >= threshold ? 0 : peakRate > 1e-6 ? Math.max(0, (threshold - peak) / peakRate) : null;
    rows.push({ id: place.id, name: place.name, people: Math.round(people), peak, trendPerMin: trend, etaMin: eta });
  }
  return rows.sort((a, b) => b.people - a.people);
}

export interface LotRow {
  id: string;
  name: string;
  people: number;
  capacity: number;
  occupancy: number;
}

/** Parking occupancy from the same density grid, never a typed number. */
export function lotRows(map: MapBundle, density: DensityLike | undefined): LotRow[] {
  if (!density) return [];
  return placesOf(map, ['parking'])
    .filter((p) => p.id !== 'lots')
    .map((place) => {
      let people = 0;
      for (const cell of place.cells) people += (density.peoplePerM2[cell] ?? 0) * AREA;
      const capacity = Math.max(1, place.capacity ?? place.cells.length * 4);
      return { id: place.id, name: place.name, people: Math.round(people), capacity, occupancy: people / capacity };
    })
    .sort((a, b) => b.occupancy - a.occupancy);
}

export interface RosterRow {
  id: string;
  unit: string;
  post: string;
  order: string;
  etaMin: number | null;
  told: number;
  followRate: number | null;
}

/** One row per officer marker, with the values the panel already receives. */
export function rosterRows(map: MapBundle, officers: readonly OfficerStatus[] | undefined): RosterRow[] {
  if (!officers) return [];
  return officers.map((officer) => {
    const place = officer.place >= 0 ? map.places[officer.place] : undefined;
    const home = map.places.find((p) => p.cells.includes(officer.homeCell));
    const order = officer.state === 'standby' ? 'Standby' : officer.state === 'en_route' ? 'En route' : 'On scene';
    return {
      id: officer.id,
      unit: officer.unit,
      post: place?.name ?? home?.name ?? 'street post',
      order: officer.place >= 0 ? `${order} — ${place?.name ?? 'post'}` : order,
      etaMin: officer.etaS === null ? null : officer.etaS / 60,
      told: officer.told,
      followRate: officer.told > 0 ? officer.followed / officer.told : null,
    };
  });
}
