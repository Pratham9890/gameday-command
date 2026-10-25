import { describe, expect, it } from 'vitest';
import { assembleRings, buildStadiumMap, extractExists, loadExtract } from './osm/stadium.ts';
import { OHIO_THEME, themeFor } from './teams.ts';

describe('stadium themes', () => {
  it('uses the first home team it knows, then the stadium name, then a generated pair', () => {
    expect(themeFor('Lumen Field', ['Seattle Seahawks', 'Seattle Sounders FC'])).toMatchObject({ team: 'Seattle Seahawks', primary: '#002244', source: 'home team from Wikidata' });
    expect(themeFor('Michigan Stadium')).toMatchObject({ team: 'Michigan Wolverines', primary: '#00274c', secondary: '#ffcb05' });
    const made = themeFor('Some Unknown Ground');
    expect(made.source).toMatch(/generated/);
    expect(made.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(themeFor('Some Unknown Ground')).toEqual(made);
  });

  it.skipIf(!extractExists())('keeps Ohio Stadium in scarlet and grey', () => {
    expect(buildStadiumMap(loadExtract()).theme).toEqual(OHIO_THEME);
  });
});

describe('multipolygon outlines', () => {
  const p = (lat: number, lon: number) => ({ lat, lon });
  it('joins outer pieces end to end, even when one runs backwards', () => {
    const rings = assembleRings([
      [p(0, 0), p(0, 1), p(1, 1)],
      [p(0, 0), p(1, 0), p(1, 1)], // reversed relative to the first
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]![0]).toEqual(rings[0]![rings[0]!.length - 1]);
    expect(rings[0]).toHaveLength(5);
  });

  it('keeps separate rings separate', () => {
    const rings = assembleRings([
      [p(0, 0), p(0, 1), p(1, 1), p(0, 0)],
      [p(5, 5), p(5, 6), p(6, 6), p(5, 5)],
    ]);
    expect(rings).toHaveLength(2);
  });
});
