import { describe, expect, it, vi } from 'vitest';
import type { WorldActions, WorldView } from '../../contracts.ts';
import { GAME_END_S, incidentsFor, safeCountFor, windowFor } from './incidents.ts';
import { createWorldHooks } from './hooks.ts';
import { playbookFor } from './playbook.ts';
import { buildStadiumMap, loadExtract } from './osm/stadium.ts';
import { makeTestMap } from './test-map.ts';

describe('game end', () => {
  it.each([makeTestMap(), buildStadiumMap(loadExtract())])('measures the stands and offers three real plans on $id', (map) => {
    const incident = incidentsFor(map).find((i) => i.kind === 'game_end');
    const stands = map.places.find((p) => p.kind === 'seating')!;
    expect(incident).toMatchObject({ at: GAME_END_S, placeId: stands.id, cells: stands.cells, safeCount: safeCountFor(stands.cells) });
    expect(windowFor(incident!)).toEqual({ startAt: GAME_END_S - 300, endAt: GAME_END_S + 3600 });
    const plans = playbookFor('game_end', map);
    expect(plans).toHaveLength(3);
    expect(new Set(plans.map((p) => JSON.stringify(p.actions))).size).toBe(3);
    for (const plan of plans) for (const action of plan.actions) {
      if ('closableId' in action) expect(map.closables.some((c) => c.id === action.closableId)).toBe(true);
      if ('toPlaceId' in action) expect(map.places.some((p) => p.id === action.toPlaceId)).toBe(true);
    }
  });

  it('raises exactly one map-wide exit order, even with an explicit exodus time', () => {
    const map = makeTestMap();
    const incident = { ...incidentsFor(map)[0]!, kind: 'game_end' as const, at: GAME_END_S };
    for (const explicit of [undefined, GAME_END_S]) {
      const hooks = createWorldHooks(incident, { id: 'empty', name: 'Empty', forIncident: 'game_end', officersAvailable: 0, actions: [] }, explicit);
      const raiseSituation = vi.fn();
      const act = { raiseSituation } as unknown as WorldActions;
      const world = { map, officers: [] } as unknown as WorldView;
      hooks.onStep(GAME_END_S - 1, world, act);
      expect(raiseSituation).not.toHaveBeenCalled();
      hooks.onStep(GAME_END_S, world, act);
      hooks.onStep(GAME_END_S + 1, world, act);
      expect(raiseSituation.mock.calls).toEqual([['exit_route']]);
    }
  });
});
