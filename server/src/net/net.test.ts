import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db.ts';
import { migratePlatform } from '../platform/schema.ts';
import { Allowlist } from './allowlist.ts';
import { classifyAddress } from './ip.ts';
import { type FetchTransport, nodeTransport, OutboundBlocked, type Resolver, safeFetch, type TransportRequest } from './safe-fetch.ts';
import { addUser, makeApp, signIn } from '../testing.ts';

describe('which addresses are public', () => {
  const blocked: [string, string][] = [
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['10.20.30.40', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'this network'],
    ['224.0.0.251', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['192.0.2.10', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fd00:ec2::254', 'unique local'],
    ['fc00::1', 'unique local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::ffff:7f00:1', 'loopback'],
    ['64:ff9b::a00:1', 'NAT64 (private)'],
    ['2002:c0a8:0101::1', '6to4 (private)'],
    ['::127.0.0.1', 'IPv4 in IPv6 (loopback)'],
  ];
  it.each(blocked)('refuses %s (%s)', (address, reason) => {
    const verdict = classifyAddress(address);
    expect(verdict.public).toBe(false);
    expect(verdict.reason).toContain(reason.split(' (')[0]!);
  });

  it.each(['8.8.8.8', '23.215.0.136', '172.32.0.1', '100.128.0.1', '2600:1f18::1', '::ffff:8.8.8.8', '64:ff9b::808:808'])('allows public %s', (address) => {
    expect(classifyAddress(address).public).toBe(true);
  });
});

/** A pretend internet: hostnames → answers, plus a record of where each request was really sent. */
function fakeNet(routes: Record<string, (req: TransportRequest) => { status: number; headers?: Record<string, string>; body?: string }>, dns: Record<string, string[] | (() => string[])>) {
  const sent: { url: string; address: string }[] = [];
  const resolver: Resolver = async (host) => {
    const answer = dns[host];
    if (!answer) throw new Error('ENOTFOUND');
    return (typeof answer === 'function' ? answer() : answer).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  const transport: FetchTransport = async (req) => {
    sent.push({ url: req.url.href, address: req.address });
    const route = routes[req.url.href];
    if (!route) return { status: 404, headers: {}, body: Buffer.from('') };
    const res = route(req);
    return { status: res.status, headers: res.headers ?? {}, body: Buffer.from(res.body ?? '') };
  };
  return { resolver, transport, sent };
}

function allowlist(...hosts: (string | { host: string; httpsOnly?: boolean; ports?: number[] })[]) {
  const db = openDb(':memory:');
  migratePlatform(db);
  const list = new Allowlist(db);
  for (const h of hosts) list.add({ ...(typeof h === 'string' ? { host: h } : h), addedBy: 'test' });
  return list;
}

const blockedBy = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OutboundBlocked);
    return (error as OutboundBlocked).reason;
  }
  throw new Error('expected the request to be blocked');
};

describe('the outbound guard (SSRF)', () => {
  it('fetches an allowlisted public host', async () => {
    const net = fakeNet({ 'https://feeds.example.gov/gates.json': () => ({ status: 200, body: '{"gates":[]}' }) }, { 'feeds.example.gov': ['23.215.0.136'] });
    const res = await safeFetch('https://feeds.example.gov/gates.json', { allowlist: allowlist('feeds.example.gov'), ...net });
    expect(res.text()).toBe('{"gates":[]}');
    expect(net.sent).toEqual([{ url: 'https://feeds.example.gov/gates.json', address: '23.215.0.136' }]);
  });

  it('refuses hosts that are not on the allowlist, and wildcard entries match subdomains only', async () => {
    const net = fakeNet({}, { 'evil.example.com': ['23.215.0.136'], 'a.feeds.example.gov': ['23.215.0.136'], 'feeds.example.gov': ['23.215.0.136'] });
    const list = allowlist('*.feeds.example.gov');
    expect(await blockedBy(safeFetch('https://evil.example.com/', { allowlist: list, ...net }))).toBe('not_allowlisted');
    expect(await blockedBy(safeFetch('https://feeds.example.gov/', { allowlist: list, ...net }))).toBe('not_allowlisted');
    await safeFetch('https://a.feeds.example.gov/', { allowlist: list, ...net });
    expect(net.sent).toHaveLength(1);
  });

  it('refuses a private IP even when an administrator allowlisted it', async () => {
    const net = fakeNet({}, {});
    const list = allowlist({ host: '10.0.0.5', httpsOnly: false, ports: [80] }, { host: '169.254.169.254', httpsOnly: false, ports: [80] });
    expect(await blockedBy(safeFetch('http://10.0.0.5/', { allowlist: list, ...net }))).toBe('private_address');
    expect(await blockedBy(safeFetch('http://169.254.169.254/latest/meta-data/', { allowlist: list, ...net }))).toBe('private_address');
    expect(net.sent).toEqual([]);
  });

  it('refuses an allowlisted name that resolves to a private address, or to any private address among public ones', async () => {
    const net = fakeNet({}, { 'feeds.example.gov': ['127.0.0.1'], 'mixed.example.gov': ['23.215.0.136', '10.1.2.3'] });
    const list = allowlist('feeds.example.gov', 'mixed.example.gov');
    expect(await blockedBy(safeFetch('https://feeds.example.gov/', { allowlist: list, ...net }))).toBe('private_address');
    expect(await blockedBy(safeFetch('https://mixed.example.gov/', { allowlist: list, ...net }))).toBe('private_address');
    expect(net.sent).toEqual([]);
  });

  it('re-checks every redirect hop: no redirect to a private address or an unlisted host', async () => {
    const net = fakeNet(
      {
        'https://feeds.example.gov/a': () => ({ status: 302, headers: { location: 'http://127.0.0.1:8009/v1/systemone' } }),
        'https://feeds.example.gov/b': () => ({ status: 301, headers: { location: 'https://internal.example.gov/' } }),
        'https://feeds.example.gov/c': () => ({ status: 307, headers: { location: 'https://elsewhere.example.com/' } }),
        'https://feeds.example.gov/d': () => ({ status: 302, headers: { location: '/e' } }),
        'https://feeds.example.gov/e': () => ({ status: 200, body: 'ok' }),
      },
      { 'feeds.example.gov': ['23.215.0.136'], 'internal.example.gov': ['192.168.10.10'], 'elsewhere.example.com': ['23.215.0.137'] },
    );
    const list = allowlist('feeds.example.gov', 'internal.example.gov', { host: '127.0.0.1', httpsOnly: false, ports: [8009] });
    expect(await blockedBy(safeFetch('https://feeds.example.gov/a', { allowlist: list, ...net }))).toBe('private_address');
    expect(await blockedBy(safeFetch('https://feeds.example.gov/b', { allowlist: list, ...net }))).toBe('private_address');
    expect(await blockedBy(safeFetch('https://feeds.example.gov/c', { allowlist: list, ...net }))).toBe('not_allowlisted');
    const followed = await safeFetch('https://feeds.example.gov/d', { allowlist: list, ...net });
    expect([followed.url, followed.text(), followed.redirects]).toEqual(['https://feeds.example.gov/e', 'ok', ['https://feeds.example.gov/d']]);
    expect(net.sent.map((s) => s.address).every((a) => a === '23.215.0.136')).toBe(true);
  });

  it('stops redirect loops', async () => {
    const net = fakeNet({ 'https://feeds.example.gov/loop': () => ({ status: 302, headers: { location: '/loop' } }) }, { 'feeds.example.gov': ['23.215.0.136'] });
    expect(await blockedBy(safeFetch('https://feeds.example.gov/loop', { allowlist: allowlist('feeds.example.gov'), ...net }))).toBe('redirect_limit');
    expect(net.sent).toHaveLength(4);
  });

  it('defeats DNS rebinding: it connects to the address it checked, and the next lookup is checked again', async () => {
    let calls = 0;
    const net = fakeNet({ 'https://feeds.example.gov/x': () => ({ status: 200, body: 'first' }) }, { 'feeds.example.gov': () => (++calls === 1 ? ['23.215.0.136'] : ['127.0.0.1']) });
    const list = allowlist('feeds.example.gov');
    await safeFetch('https://feeds.example.gov/x', { allowlist: list, ...net });
    expect(net.sent).toEqual([{ url: 'https://feeds.example.gov/x', address: '23.215.0.136' }]);
    expect(await blockedBy(safeFetch('https://feeds.example.gov/x', { allowlist: list, ...net }))).toBe('private_address');
    expect(calls).toBe(2);
    expect(net.sent).toHaveLength(1);
  });

  it('refuses other schemes, embedded credentials, HTTP to HTTPS-only hosts and unlisted ports', async () => {
    const net = fakeNet({}, { 'feeds.example.gov': ['23.215.0.136'] });
    const list = allowlist('feeds.example.gov');
    expect(await blockedBy(safeFetch('file:///etc/passwd', { allowlist: list, ...net }))).toBe('scheme');
    expect(await blockedBy(safeFetch('gopher://feeds.example.gov/', { allowlist: list, ...net }))).toBe('scheme');
    expect(await blockedBy(safeFetch('https://user:pw@feeds.example.gov/', { allowlist: list, ...net }))).toBe('credentials');
    expect(await blockedBy(safeFetch('http://feeds.example.gov/', { allowlist: list, ...net }))).toBe('https_required');
    expect(await blockedBy(safeFetch('https://feeds.example.gov:8443/', { allowlist: list, ...net }))).toBe('port');
    expect(await blockedBy(safeFetch('https://2130706433/', { allowlist: list, ...net }))).toBe('not_allowlisted');
  });
});

describe('the pinned Node transport', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<number>((done) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => done((server!.address() as AddressInfo).port));
    });

  it('connects to the vetted address whatever the hostname resolves to, sending the real Host header', async () => {
    let host = '';
    const port = await listen((req, res) => {
      host = req.headers.host ?? '';
      res.end('pinned');
    });
    const res = await nodeTransport({ url: new URL(`http://does-not-resolve.invalid:${port}/x`), address: '127.0.0.1', family: 4, headers: {}, maxBytes: 1024, signal: AbortSignal.timeout(2000) });
    expect(res.body.toString()).toBe('pinned');
    expect(host).toBe(`does-not-resolve.invalid:${port}`);
  });

  it('cuts off answers over the size limit, declared or streamed', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/declared') {
        res.setHeader('content-length', '5000');
        res.end('x'.repeat(5000));
      } else {
        res.write('x'.repeat(3000));
        res.end('x'.repeat(3000));
      }
    });
    const call = (path: string) => nodeTransport({ url: new URL(`http://feeds.test:${port}${path}`), address: '127.0.0.1', family: 4, headers: {}, maxBytes: 4096, signal: AbortSignal.timeout(2000) });
    await expect(call('/declared')).rejects.toMatchObject({ reason: 'too_large' });
    await expect(call('/streamed')).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('gives up at the deadline', async () => {
    const port = await listen(() => {
      /* never answers */
    });
    const list = allowlist({ host: 'slow.example.gov', httpsOnly: false, ports: [port] });
    const transport: FetchTransport = (req) => nodeTransport({ ...req, address: '127.0.0.1' });
    const started = Date.now();
    expect(await blockedBy(safeFetch(`http://slow.example.gov:${port}/`, { allowlist: list, resolver: async () => [{ address: '23.215.0.136', family: 4 }], transport }, { timeoutMs: 300 }))).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('the conditions fetch routes', () => {
  it('replace the open v2 fetch: allowlisted hosts only, refusals audited', async () => {
    const net = fakeNet({ 'https://scans.osu.example.gov/now.json': () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"source":"Gate scans","gates":[]}' }) }, { 'scans.osu.example.gov': ['23.215.0.136'] });
    const { app, platform } = makeApp({}, { resolver: net.resolver, transport: net.transport });
    // First run (loopback, no accounts): the v2 route works but is guarded.
    const v2 = (url: string) => app.request('/api/conditions/fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
    expect((await v2('http://169.254.169.254/latest/meta-data/')).status).toBe(403);
    expect((await v2('http://localhost:8009/v1/models')).status).toBe(403);
    platform.allowlist.add({ host: 'scans.osu.example.gov', addedBy: 'test' });
    const ok = await v2('https://scans.osu.example.gov/now.json');
    expect(ok.status).toBe(200);
    expect((await ok.json()).text).toContain('Gate scans');
    expect(platform.audit.list({ action: 'outbound.blocked' }).map((e) => e.detail.reason)).toEqual(['not_allowlisted', 'not_allowlisted']);

    await addUser(platform, 'admin.one', [{ position: 'admin', scope: '*' }]);
    await addUser(platform, 'gates.one', [{ position: 'gates' }]);
    const admin = await signIn(app, 'admin.one');
    const gates = await signIn(app, 'gates.one');
    expect((await gates.post('/api/v3/feeds/allowlist', { host: 'evil.example.com' })).status).toBe(403);
    expect((await admin.json('GET', '/api/v3/feeds/allowlist')).body.map((e: { host: string }) => e.host)).toEqual(['api.weather.gov', 'scans.osu.example.gov']);
    expect((await admin.post('/api/v3/feeds/allowlist', { host: 'not a host' })).status).toBe(400);
    const v3 = await gates.json('POST', '/api/v3/feeds/fetch', { url: 'https://scans.osu.example.gov/now.json' });
    expect(v3.status).toBe(200);
    expect(v3.body.provenance).toMatchObject({ kind: 'observed', source: 'scans.osu.example.gov' });
    expect((await admin.del('/api/v3/feeds/allowlist/scans.osu.example.gov')).status).toBe(200);
    expect((await gates.post('/api/v3/feeds/fetch', { url: 'https://scans.osu.example.gov/now.json' })).status).toBe(403);
  });
});
