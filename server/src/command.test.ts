import { describe, expect, it } from 'vitest';
import { makeTestMap } from '../../world/src/test-map.ts';
import { parseConditions } from '../../app/src/conditions.ts';
import { openDb } from './db.ts';
import { createApp } from './index.ts';

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('command routes', () => {
  it('averages history per gate and minute across runs', async () => {
    const app = createApp(openDb(':memory:'));
    await post(app, '/api/history', { mapId: 'm', runId: 'r1', samples: [{ kind: 'gate_waiting', subject: 'gate-1', minute: -10, value: 400 }] });
    await post(app, '/api/history', {
      mapId: 'm',
      runId: 'r2',
      samples: [
        { kind: 'gate_waiting', subject: 'gate-1', minute: -10, value: 800 },
        { kind: 'nonsense', subject: 'x', minute: 0, value: 1 },
      ],
    });
    const res = (await (await app.request('/api/history?map=m')).json()) as { runs: number; samples: { subject: string; mean: number; n: number }[] };
    expect(res.runs).toBe(2);
    expect(res.samples).toEqual([{ kind: 'gate_waiting', subject: 'gate-1', minute: -10, mean: 600, n: 2 }]);
  });

  it('keeps what officers thought, newest first, per map', async () => {
    const app = createApp(openDb(':memory:'));
    await post(app, '/api/feedback', { mapId: 'm', pick: 'A', agree: true, note: 'first' });
    await post(app, '/api/feedback', { mapId: 'm', pick: 'C', agree: false, note: 'second' });
    await post(app, '/api/feedback', { mapId: 'other', pick: 'B' });
    const list = (await (await app.request('/api/feedback?map=m')).json()) as { note: string }[];
    expect(list.map((f) => f.note)).toEqual(['second', 'first']);
  });

  it('lists the maps it can serve', async () => {
    const app = createApp(openDb(':memory:'));
    const maps = (await (await app.request('/api/maps')).json()) as { id: string }[];
    expect(maps.some((m) => m.id === 'test-3gate')).toBe(true);
  });

  it('refuses feed URLs that are not http or https', async () => {
    const app = createApp(openDb(':memory:'));
    expect((await post(app, '/api/conditions/fetch', { url: 'file:///etc/passwd' })).status).toBe(400);
    expect((await post(app, '/api/conditions/fetch', { url: 'not a url' })).status).toBe(400);
  });
});

describe('conditions feed format', () => {
  const map = makeTestMap();
  const gate = map.places.find((p) => p.kind === 'gate')!;

  it('reads JSON by gate name, ignoring a "(N)" suffix and case', () => {
    const c = parseConditions(JSON.stringify({ source: 'Gate scans', at: '2026-10-24T15:00:00Z', gates: [{ gate: gate.name.toUpperCase(), waiting: 1400 }, { gate: 'Gate 99', waiting: 5 }] }), map);
    expect(c.source).toBe('Gate scans');
    expect(c.gates.get(gate.id)).toBe(1400);
    expect(c.unmatched).toEqual(['gate Gate 99']);
  });

  it('carries the minute to kickoff when the feed gives one, and none otherwise', () => {
    expect(parseConditions(JSON.stringify({ minuteToKickoff: -20, gates: [] }), map).minuteToKickoff).toBe(-20);
    expect(parseConditions(`minute,,-15\ngate,${gate.name},10`, map).minuteToKickoff).toBe(-15);
    expect(parseConditions(`gate,${gate.name},10`, map).minuteToKickoff).toBeNull();
  });

  it('reads CSV lines and reports what it could not match', () => {
    const c = parseConditions(`kind,name,value\ngate,${gate.name},250\nstreet,Nowhere Road,4\ngate,${gate.name},oops`, map);
    expect(c.gates.get(gate.id)).toBe(250);
    expect(c.unmatched).toHaveLength(2);
  });
});
