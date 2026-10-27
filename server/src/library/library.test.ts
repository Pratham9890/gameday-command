import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResponsePlan } from '../../../contracts.ts';
import type { PackageFile } from '../types.ts';
import { openDb } from '../db.ts';
import { migratePlatform } from '../platform/schema.ts';
import { canonicalJson, sha256Hex } from '../platform/canonical.ts';
import { testConfig } from '../platform/config.ts';
import { createApp } from '../index.ts';
import { DocumentError, DocumentStore } from './documents.ts';
import { ComparisonStore, tapeHashOf } from './comparisons.ts';
import { buildPackage, importPackage } from './packages.ts';
import { FakeClock, addUser, makeApp, signIn } from '../testing.ts';

const author = { userId: 'u-plan', name: 'Planning Chief', position: 'planning_chief' };
const reviewer = { userId: 'u-safety', name: 'Safety Officer', position: 'safety_officer' };
const ic = { userId: 'u-ic', name: 'Incident Commander', position: 'incident_commander' };

const plan: ResponsePlan = {
  id: 'gate10-surge-a',
  name: 'Open Gate 20, PA alert, 6 officers to Gate 10',
  forIncident: 'gate_surge',
  officersAvailable: 24,
  actions: [
    { at: 0, type: 'open', closableId: 'gate-20-door' },
    { at: 30, type: 'alert', channel: 'pa', message: 'Gate 20 is open: use it', reachShare: 0.6 },
  ],
};

function store(twoPerson = false) {
  const db = openDb(':memory:');
  migratePlatform(db);
  const clock = new FakeClock();
  return { db, clock, docs: new DocumentStore(db, clock.now, twoPerson), comparisons: new ComparisonStore(db, clock.now) };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return [(error as DocumentError).status, (error as DocumentError).code];
  }
  return null;
};

describe('versioned documents: draft → reviewed → approved', () => {
  it('edits a draft in place with compare-and-set on the revision', () => {
    const { docs, clock } = store();
    const { doc } = docs.create(author, { id: plan.id, kind: 'plan', scope: 'osu-2026', name: plan.name, body: { responsePlan: plan } });
    expect(doc).toMatchObject({ version: 1, revision: 1, status: 'draft', author: { name: 'Planning Chief', position: 'planning_chief' } });
    clock.advance(60_000);
    const edited = docs.update(author, plan.id, { expectedVersion: 1, expectedRevision: 1, body: { responsePlan: { ...plan, officersAvailable: 30 } } });
    expect(edited).toMatchObject({ newVersion: false, doc: { version: 1, revision: 2 } });
    expect(edited.doc.updated).toBe('2026-10-31T16:01:00.000Z');
    // A second editor who loaded revision 1 is refused, with the current state to show.
    expect(code(() => docs.update(reviewer, plan.id, { expectedVersion: 1, expectedRevision: 1, name: 'stale edit' }))).toEqual([409, 'version_conflict']);
  });

  it('moves through review to approval, in that order only', () => {
    const { docs } = store();
    docs.create(author, { id: 'p', kind: 'plan', scope: 'osu-2026', name: 'P', body: {} });
    expect(code(() => docs.approve(ic, 'p', 1))).toEqual([409, 'invalid_state']);
    const reviewed = docs.review(reviewer, 'p', 1);
    expect(reviewed).toMatchObject({ status: 'reviewed', reviewedBy: { name: 'Safety Officer' } });
    const approved = docs.approve(ic, 'p', 1);
    expect(approved).toMatchObject({ status: 'approved', approvedBy: { name: 'Incident Commander', position: 'incident_commander' } });
    expect(code(() => docs.review(reviewer, 'p', 1))).toEqual([409, 'invalid_state']);
  });

  it('never changes an approved version: an edit makes version n + 1, and SQLite refuses direct writes', () => {
    const { db, docs } = store();
    docs.create(author, { id: 'p', kind: 'plan', scope: 'osu-2026', name: 'P', body: { responsePlan: plan } });
    docs.review(reviewer, 'p', 1);
    const v1 = docs.approve(ic, 'p', 1);
    const next = docs.update(author, 'p', { expectedVersion: 1, body: { responsePlan: { ...plan, officersAvailable: 12 } } });
    expect(next).toMatchObject({ newVersion: true, doc: { version: 2, revision: 1, status: 'draft', parentVersion: 1 } });
    expect(docs.get('p', 1)).toEqual(v1);
    expect(docs.latestApproved('p')!.version).toBe(1);
    expect(() => db.prepare("update documents set name = 'tampered' where id = 'p' and version = 1").run()).toThrow(/immutable/);
    expect(() => db.prepare("delete from documents where id = 'p' and version = 1").run()).toThrow(/immutable/);
    // Editing a reviewed draft sends it back for review.
    docs.review(reviewer, 'p', 2);
    expect(docs.update(author, 'p', { expectedVersion: 2, name: 'P (tweaked)' }).doc).toMatchObject({ status: 'draft', reviewedBy: null, revision: 2 });
    expect(docs.versions('p').map((v) => [v.version, v.status])).toEqual([
      [1, 'approved'],
      [2, 'draft'],
    ]);
  });

  it('can require two people: the author may not review or approve their own version', () => {
    const { docs } = store(true);
    docs.create(ic, { id: 'p', kind: 'plan', scope: 'osu-2026', name: 'P', body: {} });
    expect(code(() => docs.review(ic, 'p', 1))).toEqual([403, 'two_person_rule']);
    docs.review(reviewer, 'p', 1);
    expect(code(() => docs.approve(ic, 'p', 1))).toEqual([403, 'two_person_rule']);
  });

  it('checks the body for each kind and warns about personal data in its free text', () => {
    const { docs } = store();
    expect(code(() => docs.create(author, { kind: 'scenario', scope: 'osu-2026', name: 'S', body: { mapId: 'ohio-stadium' } }))).toEqual([400, 'invalid_body']);
    expect(code(() => docs.create(author, { kind: 'plan', scope: 'osu-2026', name: 'P', body: { responsePlan: { ...plan, actions: [{ at: 0, type: 'teleport' }] } } }))).toEqual([400, 'invalid_body']);
    const { warnings } = docs.create(author, { kind: 'scenario', scope: 'osu-2026', name: 'S', body: { mapId: 'ohio-stadium', seed: 42, notes: 'Contact Mr. Smith at 614-555-0100' } });
    expect(warnings.map((w) => w.kind).sort()).toEqual(['personal_title', 'phone']);
  });
});

describe('package files', () => {
  function packaged() {
    const s = store();
    s.docs.create(author, { id: 'osu-gate-surge', kind: 'scenario', scope: 'osu-2026', name: 'Gate 10 surge at kickoff', body: { mapId: 'ohio-stadium', seed: 20261031, incident: { kind: 'gate_surge', at: 3600, placeId: 'gate-10' } } });
    s.docs.create(author, { id: plan.id, kind: 'plan', scope: 'osu-2026', name: plan.name, body: { responsePlan: plan } });
    s.docs.review(reviewer, plan.id, 1);
    s.docs.approve(ic, plan.id, 1);
    const comparison = s.comparisons.create(author, {
      scope: 'osu-2026',
      incident: { id: 'i1', kind: 'gate_surge', at: 3600 },
      scorecards: [{ runId: 'r-A', planId: plan.id, label: 'A', timeToClearMin: 12, peakDensity: 4.1, dangerMinutes: 7, firstOfficerMin: 3, officerMinutesUsed: 40, fansNotReached: 900, fallbackDecisions: 2 }],
      seed: 20261031,
      tape: { runId: 'r-A', answers: [{ t: 10, answer: { key: 'k', odds: { a: 1 }, source: 'default' } }] },
      engineVersion: 'ts-0.1.0',
      mapId: 'ohio-stadium',
    });
    const file = buildPackage({ documents: [s.docs.latest('osu-gate-surge')!, s.docs.latest(plan.id)!], comparisons: [comparison], engineVersion: 'ts-0.1.0', exportedBy: { userId: author.userId, position: author.position }, now: s.clock.now() });
    return { ...s, file, comparison };
  }

  it('carries schema version, engine version, seed, definitions and an integrity hash', () => {
    const { file, comparison } = packaged();
    expect(file).toMatchObject({ format: 'gameday.package', schemaVersion: '1.0.0', contractVersion: 'gameday.v3', engineVersion: 'ts-0.1.0', seed: 20261031, classification: 'internal' });
    expect(file.documents.map((d) => [d.id, d.kind, d.version, d.status, d.approvedBy])).toEqual([
      ['osu-gate-surge', 'scenario', 1, 'draft', null],
      [plan.id, 'plan', 1, 'approved', 'Incident Commander'],
    ]);
    const { integrity, ...rest } = file;
    expect(integrity.hash).toBe(sha256Hex(canonicalJson(rest)));
    expect(comparison.tapeHash).toBe(tapeHashOf({ runId: 'r-A', answers: [{ t: 10, answer: { key: 'k', odds: { a: 1 }, source: 'default' } }] }));
  });

  it('imports into another server as drafts that remember where they came from', () => {
    const { file } = packaged();
    const target = store();
    const result = importPackage(JSON.parse(JSON.stringify(file)), target.docs, target.comparisons, { userId: 'u2', name: 'Other Planner', position: 'planning_chief' });
    expect(result.imported.map((d) => [d.id, d.version])).toEqual([
      ['osu-gate-surge', 1],
      [plan.id, 1],
    ]);
    expect(result.comparisons).toBe(1);
    const imported = target.docs.latest(plan.id)!;
    expect(imported).toMatchObject({ status: 'draft', importedFrom: { status: 'approved', approvedBy: 'Incident Commander', version: 1, packageHash: file.integrity.hash } });
    expect((imported.body as { responsePlan: ResponsePlan }).responsePlan).toEqual(plan);
    // Importing the same file again changes nothing.
    expect(importPackage(JSON.parse(JSON.stringify(file)), target.docs, target.comparisons, author).skipped).toHaveLength(2);
  });

  it('refuses an altered file, a body that does not match its hash, and another major schema', () => {
    const { file } = packaged();
    const target = store();
    const altered = JSON.parse(JSON.stringify(file)) as PackageFile;
    (altered.documents[1]!.body as { responsePlan: ResponsePlan }).responsePlan.officersAvailable = 1;
    expect(code(() => importPackage(altered, target.docs, target.comparisons, author))).toEqual([422, 'integrity_failed']);
    const rehashed = JSON.parse(JSON.stringify(altered)) as PackageFile;
    const { integrity: _i, ...rest } = rehashed;
    rehashed.integrity.hash = sha256Hex(canonicalJson(rest));
    expect(code(() => importPackage(rehashed, target.docs, target.comparisons, author))).toEqual([422, 'integrity_failed']);
    const future = { ...JSON.parse(JSON.stringify(file)), schemaVersion: '2.0.0' };
    expect(code(() => importPackage(future, target.docs, target.comparisons, author))).toEqual([422, 'incompatible_schema']);
    expect(code(() => importPackage({ format: 'something-else' }, target.docs, target.comparisons, author))).toEqual([400, 'invalid_package']);
  });
});

describe('documents over HTTP', () => {
  it('lets each position do only its part of the workflow, and announces approvals on the timeline', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'planner', [{ position: 'planning_chief' }]);
    await addUser(platform, 'safety', [{ position: 'safety_officer' }]);
    await addUser(platform, 'ic.one', [{ position: 'incident_commander' }]);
    await addUser(platform, 'unit', [{ position: 'field_unit', unit: 'OSU PD 12' }]);
    const [planner, safety, icC, unit] = await Promise.all(['planner', 'safety', 'ic.one', 'unit'].map((u) => signIn(app, u)));
    expect((await unit.post('/api/v3/documents', { kind: 'plan', scope: 'osu-2026', name: 'x', body: {} })).status).toBe(403);
    const created = await planner.json('POST', '/api/v3/documents', { id: plan.id, kind: 'plan', scope: 'osu-2026', name: plan.name, body: { responsePlan: plan } });
    expect(created.status).toBe(201);
    expect((await planner.post(`/api/v3/documents/${plan.id}/versions/1/approve`)).status).toBe(403);
    expect((await safety.post(`/api/v3/documents/${plan.id}/versions/1/review`, { expectedRevision: 1 })).status).toBe(200);
    expect((await icC.post(`/api/v3/documents/${plan.id}/versions/1/approve`)).status).toBe(200);
    const edit = await planner.json('PUT', `/api/v3/documents/${plan.id}`, { expectedVersion: 1, name: 'Plan A, revised' });
    expect([edit.status, edit.body.newVersion, edit.body.document.version]).toEqual([201, true, 2]);
    const read = await icC.json('GET', `/api/v3/documents/${plan.id}`);
    expect(read.body).toMatchObject({ version: 2, latestApproved: 1, versions: [{ version: 1, status: 'approved' }, { version: 2, status: 'draft' }] });
    expect((await unit.get(`/api/v3/documents/${plan.id}`)).status).toBe(403);
    const timeline = (await icC.json('GET', '/api/v3/events?stream=osu-2026/library')).body.events.map((e: { type: string }) => e.type);
    expect(timeline).toEqual(['document.reviewed', 'document.approved']);
    expect(platform.audit.list().map((e) => e.action)).toEqual(expect.arrayContaining(['document.create', 'document.review', 'document.approve', 'document.update']));
  });

  it('audits every view of a restricted document, and exports packages only to those who may', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'planner', [{ position: 'planning_chief' }, { position: 'planning_chief', scope: 'osu-2027' }]);
    await addUser(platform, 'pio', [{ position: 'pio' }]);
    const planner = await signIn(app, 'planner');
    const pio = await signIn(app, 'pio');
    await planner.post('/api/v3/documents', { id: 'radio-annex', kind: 'plan', scope: 'osu-2026', name: 'Deployment and radio annex', classification: 'restricted', body: {} });
    expect((await pio.get('/api/v3/documents/radio-annex')).status).toBe(200);
    expect(platform.audit.list({ action: 'document.view' }).map((e) => e.actor.position)).toEqual(['pio']);
    expect((await pio.get('/api/v3/documents/radio-annex/export')).status).toBe(403);
    const exported = await planner.request('GET', '/api/v3/documents/radio-annex/export');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-disposition')).toMatch(/attachment; filename="gameday-package-[0-9a-f]{12}\.json"/);
    const file = await exported.json();
    const imported = await planner.json('POST', '/api/v3/packages/import', { package: file, scope: 'osu-2027' });
    expect(imported.status).toBe(201);
    // Same id and body already here: nothing is duplicated.
    expect(imported.body.skipped[0]).toMatchObject({ id: 'radio-annex', reason: 'already here as version 1' });
  });

  it('stores comparisons with seed, tape hash and versions, and refuses a tape that does not match its hash', async () => {
    const { app, platform } = makeApp();
    await addUser(platform, 'ic.one', [{ position: 'incident_commander' }]);
    const icC = await signIn(app, 'ic.one');
    const body = {
      scope: 'osu-2026',
      incident: { id: 'i1', kind: 'lightning_delay', at: 5400 },
      scorecards: [{ runId: 'r', planId: 'p', label: 'A', timeToClearMin: null, peakDensity: 3, dangerMinutes: 0, firstOfficerMin: null, officerMinutesUsed: 0, fansNotReached: 0, fallbackDecisions: 0 }],
      seed: 7,
      seeds: [7, 8, 9],
      tape: { runId: 'r', answers: [] },
      engineVersion: 'wasm-1.0.0+abc123',
      mapId: 'ohio-stadium',
      planRefs: [{ planId: 'p', label: 'A', documentId: 'p', version: 3 }],
      scenarioRef: { id: 's', version: 2 },
    };
    const saved = await icC.json('POST', '/api/v3/comparisons', body);
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ seed: 7, seeds: [7, 8, 9], tapeHash: tapeHashOf({ runId: 'r', answers: [] }), engineVersion: 'wasm-1.0.0+abc123', contractVersion: 'gameday.v3', planRefs: [{ version: 3 }], scenarioRef: { version: 2 } });
    expect((await icC.json('GET', `/api/v3/comparisons/${saved.body.id}`)).body.id).toBe(saved.body.id);
    expect((await icC.post('/api/v3/comparisons', { ...body, tapeHash: '0'.repeat(64) })).status).toBe(400);
  });
});

describe('plans saved through the v2 route survive a reload (audit defect D-14)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every save as a versioned, attributed draft that a new server process reads back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gd-plans-'));
    dirs.push(dir);
    const path = join(dir, 'gameday.db');
    const post = (app: ReturnType<typeof createApp>, body: unknown) => app.request('/api/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const first = createApp(openDb(path), { config: testConfig(), dbPath: path });
    expect(await (await post(first, plan)).json()).toMatchObject({ id: plan.id, version: 1, revision: 1 });
    expect(await (await post(first, { ...plan, officersAvailable: 18 })).json()).toMatchObject({ version: 1, revision: 2 });

    // "Reload": a new process on the same database file.
    const second = createApp(openDb(path), { config: testConfig(), dbPath: path });
    const plans = (await (await second.request('/api/plans?incident=gate_surge')).json()) as ResponsePlan[];
    const saved = plans.filter((p) => p.id === plan.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.officersAvailable).toBe(18);
    expect(plans.length).toBeGreaterThanOrEqual(4);
  });
});
