import { describe, expect, it } from 'vitest';
import type { SceneInfo } from '../../engine/src/edits.ts';
import { afterActionHtml, inverseOrder, lastUndoable, timeline } from './after-action.ts';

const scene = (orders: SceneInfo['orders']): SceneInfo => ({ t: 600, officers: [], closed: [], orders } as unknown as SceneInfo);

describe('undo', () => {
  it('inverts gates, barricades, dispatches and redirects', () => {
    expect(inverseOrder({ type: 'gate', closableId: 'g1', closed: true }, null)).toEqual({ type: 'gate', closableId: 'g1', closed: false });
    expect(inverseOrder({ type: 'dispatch', officerIds: ['o1'], toCell: 5 }, null)).toEqual({ type: 'recall', officerIds: ['o1'] });
    expect(inverseOrder({ type: 'redirect', fromPlaceId: 'a', toPlaceId: 'b' }, null)).toEqual({ type: 'redirect', fromPlaceId: 'b', toPlaceId: 'a' });
    expect(inverseOrder({ type: 'barricade', closableId: 'b1', closed: true, name: 'X' }, null)).toMatchObject({ closed: false });
  });

  it('has no inverse for an alert or a release', () => {
    expect(inverseOrder({ type: 'release' }, null)).toBeNull();
    expect(inverseOrder({ type: 'alert', channel: 'pa', message: 'hi', reachShare: 0.5 }, null)).toBeNull();
  });

  it('skips orders that cannot be undone to find the newest that can', () => {
    const s = scene([
      { t: 10, order: { type: 'gate', closableId: 'g1', closed: true } },
      { t: 20, order: { type: 'release' } },
    ]);
    expect(lastUndoable(s)).toMatchObject({ t: 10, inverse: { type: 'gate', closed: false } });
  });
});

describe('timeline', () => {
  it('orders entries by time and labels accepted suggestions', () => {
    const s = scene([
      { t: 30, order: { type: 'respond', officerIds: ['o1'], toCell: 1, kind: 'crowd', reason: 'r', returnAfterS: 180, suggestionAt: 25 } },
      { t: 10, order: { type: 'gate', closableId: 'g1', closed: true } },
    ]);
    s.responseArrivals = [{ officerId: 'o1', startedAt: 30, arrivedAt: 90, targetCell: 1, suggestionAt: 25 }];
    const entries = timeline(s, (o) => o.type, () => 'Unit 1');
    expect(entries.map((e) => e.kind)).toEqual(['order', 'suggestion accepted', 'arrival']);
    expect(entries[2]!.text).toContain('1.1 min after the suggestion');
  });

  it('escapes text in the printable report', () => {
    const html = afterActionHtml('Run <A>', [{ t: 0, clock: '0:00', kind: 'order', text: '<script>' }], null);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});
