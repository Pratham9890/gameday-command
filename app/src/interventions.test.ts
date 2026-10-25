import { describe, expect, it } from 'vitest';
import { INTERVENTION_LABELS, interventionSteps, type InterventionKind } from './interventions.ts';

describe('intervention presets compile to contract plan steps', () => {
  it('compiles every preset exactly, with no extra fields', () => {
    const cases: [InterventionKind, Parameters<typeof interventionSteps>[1], unknown][] = [
      ['close-road', { streetId: 'street-woody-hayes-drive' }, [{ at: 0, type: 'close', closableId: 'street-woody-hayes-drive' }]],
      ['open-road', { streetId: 'street-woody-hayes-drive', at: 60 }, [{ at: 60, type: 'open', closableId: 'street-woody-hayes-drive' }]],
      ['post-officers', { gateId: 'gate-1', count: 6, at: 30 }, [{ at: 30, type: 'send_officers', count: 6, toPlaceId: 'gate-1' }]],
      ['hold-officers', { officerIds: ['off-1', 'off-2'] }, [{ at: 0, type: 'hold_officers', officerIds: ['off-1', 'off-2'] }]],
      ['close-gate', { gateId: 'gate-2' }, [{ at: 0, type: 'close', closableId: 'gate-2' }]],
      ['open-gate', { gateId: 'gate-2' }, [{ at: 0, type: 'open', closableId: 'gate-2' }]],
      ['lane-control', { gateId: 'gate-3', count: 4 }, [{ at: 0, type: 'send_officers', count: 4, toPlaceId: 'gate-3' }]],
      [
        'divert-lot',
        { fromLotId: 'lot-1', toLotId: 'lot-2', message: 'Lot 1 full', reachShare: 0.5, at: 10 },
        [
          { at: 10, type: 'redirect', fromPlaceId: 'lot-1', toPlaceId: 'lot-2' },
          { at: 10, type: 'alert', channel: 'pa', message: 'Lot 1 full', reachShare: 0.5 },
        ],
      ],
      ['alert-pa', { message: 'Move', reachShare: 0.8 }, [{ at: 0, type: 'alert', channel: 'pa', message: 'Move', reachShare: 0.8 }]],
      ['alert-phone', { message: 'Avoid', reachShare: 0.6 }, [{ at: 0, type: 'alert', channel: 'phone', message: 'Avoid', reachShare: 0.6 }]],
      ['shelter', { shelterIds: ['concourse'] }, [{ at: 0, type: 'shelter_order', shelterPlaceIds: ['concourse'] }]],
    ];
    for (const [kind, ctx, expected] of cases) expect(interventionSteps(kind, ctx), kind).toEqual(expected);
  });

  it('labels every kind', () => {
    expect(Object.keys(INTERVENTION_LABELS).sort()).toEqual(
      [
        'alert-pa',
        'alert-phone',
        'close-gate',
        'close-road',
        'divert-lot',
        'hold-officers',
        'lane-control',
        'open-gate',
        'open-road',
        'post-officers',
        'shelter',
      ].sort(),
    );
  });

  it('refuses a preset without its required place instead of guessing one', () => {
    expect(() => interventionSteps('close-road')).toThrow(/streetId/);
    expect(() => interventionSteps('post-officers')).toThrow(/gateId/);
    expect(() => interventionSteps('divert-lot', { fromLotId: 'lot-1' })).toThrow(/toLotId/);
  });

  it('clamps the officer count to at least one', () => {
    expect(interventionSteps('post-officers', { gateId: 'gate-1', count: 0 })[0]).toMatchObject({ count: 1 });
  });
});
