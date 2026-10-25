import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchStadiums, type StadiumHit } from './fetch.ts';

/**
 * `searchStadiums` reads the address parts Nominatim happens to fill in, and
 * the same stadium arrives under `city`, `town`, `village` or `county` depending
 * on its size. These tests pin the fallback order and the comma handling without
 * touching the network: every answer comes from a stubbed `fetch`, and
 * `afterEach` puts the real globals back.
 */

const TEST_URL = 'https://nominatim.test';

interface NominatimRow {
  category: string;
  type: string;
  osm_type: 'way' | 'relation';
  osm_id: number;
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  address?: Record<string, string>;
  extratags?: Record<string, string>;
  importance?: number;
}

/** A row Nominatim would keep, before any address part is filled in. */
function row(overrides: Partial<NominatimRow> = {}): NominatimRow {
  return {
    category: 'leisure',
    type: 'stadium',
    osm_type: 'way',
    osm_id: 4616839,
    lat: '40.0017000',
    lon: '-83.0191000',
    name: 'Test Stadium',
    display_name: 'Test Stadium, Woody Hayes Drive, Columbus, Franklin County, Ohio, United States',
    importance: 0.5,
    ...overrides,
  };
}

/** Answers the next `fetch` with `rows`, in the shape `jsonv2` returns them. */
function stubNominatim(rows: NominatimRow[]) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function onlyHit(hits: StadiumHit[]): StadiumHit {
  expect(hits).toHaveLength(1);
  return hits[0]!;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('searchStadiums address parts', () => {
  it('reads city, state and country into where', async () => {
    const fetchMock = stubNominatim([
      row({
        osm_type: 'relation',
        osm_id: 1131329,
        address: { city: 'Columbus', state: 'Ohio', country: 'United States' },
        extratags: { capacity: '102780', wikidata: 'Q1131329' },
      }),
    ]);

    const hit = onlyHit(await searchStadiums('Test Stadium', TEST_URL));

    expect(hit.where).toBe('Columbus, Ohio, United States');
    expect(hit.city).toBe('Columbus');
    expect(hit.state).toBe('Ohio');
    expect(hit.country).toBe('United States');
    expect(hit.name).toBe('Test Stadium');
    expect(hit.osmType).toBe('relation');
    expect(hit.osmId).toBe(1131329);
    expect(hit.lat).toBe(40.0017);
    expect(hit.lon).toBe(-83.0191);
    expect(hit.capacity).toBe(102_780);
    expect(hit.wikidata).toBe('Q1131329');

    // The test URL, not Nominatim, is what got asked.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requested = String(fetchMock.mock.calls[0]![0]);
    expect(requested.startsWith(`${TEST_URL}/search?`)).toBe(true);
    expect(requested).toContain('q=Test+Stadium');
  });

  it('falls back to town when the address has no city', async () => {
    stubNominatim([
      row({
        name: 'Beaver Stadium',
        address: { town: 'State College', state: 'Pennsylvania', country: 'United States' },
      }),
    ]);

    const hit = onlyHit(await searchStadiums('Beaver Stadium', TEST_URL));

    expect(hit.where).toBe('State College, Pennsylvania, United States');
    expect(hit.city).toBe('State College');
    expect(hit.state).toBe('Pennsylvania');
    expect(hit.country).toBe('United States');
  });

  it('falls back to village when there is no city or town', async () => {
    stubNominatim([
      row({ address: { village: 'Oregon', state: 'Ohio', country: 'United States' } }),
    ]);

    const hit = onlyHit(await searchStadiums('Test Stadium', TEST_URL));

    expect(hit.where).toBe('Oregon, Ohio, United States');
    expect(hit.city).toBe('Oregon');
    expect(hit.state).toBe('Ohio');
    expect(hit.country).toBe('United States');
  });

  it('falls back to county when no city, town, village or municipality is mapped', async () => {
    stubNominatim([
      row({
        osm_type: 'relation',
        address: { county: 'Franklin County', state: 'Ohio', country: 'United States' },
      }),
    ]);

    const hit = onlyHit(await searchStadiums('Test Stadium', TEST_URL));

    expect(hit.where).toBe('Franklin County, Ohio, United States');
    expect(hit.city).toBe('Franklin County');
    expect(hit.state).toBe('Ohio');
    expect(hit.country).toBe('United States');
  });

  it('leaves out a missing state without a double comma or dangling separator', async () => {
    stubNominatim([
      row({ address: { city: 'Columbus', country: 'United States' } }),
    ]);

    const hit = onlyHit(await searchStadiums('Test Stadium', TEST_URL));

    expect(hit.where).toBe('Columbus, United States');
    expect(hit.city).toBe('Columbus');
    expect(hit.state).toBeUndefined();
    expect(hit.country).toBe('United States');
    expect(hit.where.split(', ')).toEqual(['Columbus', 'United States']);
    expect(hit.where).not.toMatch(/,\s*,/);
    expect(hit.where.startsWith(',')).toBe(false);
    expect(hit.where.endsWith(',')).toBe(false);
  });
});
