import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Allowlist } from './allowlist.ts';
import { classifyAddress } from './ip.ts';

/**
 * The only way this server makes an outbound request (PLT-14, PLT-24).
 *
 * 1. http(s) only, no credentials in the URL, host on the admin allowlist,
 *    port allowed for that host, HTTPS unless the entry says otherwise.
 * 2. The host is resolved once, and every address it resolves to must be
 *    public; one private answer refuses the lot.
 * 3. The connection goes to the address that was checked (the socket's
 *    lookup is pinned), so a DNS server that answers differently the second
 *    time — DNS rebinding — cannot steer the request inside.
 * 4. Redirects are followed by hand, at most three, and every hop is checked
 *    from step 1 again.
 * 5. One deadline covers DNS, connect, headers and body; the body is counted
 *    as it streams and cut off at the size limit.
 */
export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface TransportRequest {
  url: URL;
  address: string;
  family: number;
  headers: Record<string, string>;
  maxBytes: number;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type FetchTransport = (req: TransportRequest) => Promise<TransportResponse>;

export type BlockReason = 'scheme' | 'credentials' | 'not_allowlisted' | 'port' | 'https_required' | 'private_address' | 'dns' | 'redirect_limit' | 'too_large' | 'timeout' | 'network';

export class OutboundBlocked extends Error {
  readonly reason: BlockReason;
  readonly url: string;
  constructor(
    reason: BlockReason,
    message: string,
    url: string,
  ) {
    super(message);
    this.reason = reason;
    this.url = url;
  }
}

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

export interface SafeResponse extends TransportResponse {
  url: string;
  address: string;
  redirects: string[];
  text(): string;
}

export interface SafeFetchDeps {
  allowlist: Allowlist;
  resolver: Resolver;
  transport: FetchTransport;
  now?: () => number;
}

export const defaultResolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(rawUrl: string, deps: SafeFetchDeps, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const maxBytes = opts.maxBytes ?? 512 * 1024;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const signal = AbortSignal.timeout(timeoutMs);
  const redirects: string[] = [];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundBlocked('scheme', 'not a URL', rawUrl);
  }

  for (let hop = 0; ; hop++) {
    const { address, family } = await vet(url, deps, signal);
    let res: TransportResponse;
    try {
      res = await deps.transport({ url, address, family, headers: { 'accept-encoding': 'identity', ...opts.headers }, maxBytes, signal });
    } catch (error) {
      if (error instanceof OutboundBlocked) throw error;
      if (signal.aborted) throw new OutboundBlocked('timeout', `no complete answer within ${timeoutMs} ms`, url.href);
      throw new OutboundBlocked('network', `request failed: ${error instanceof Error ? error.message : String(error)}`, url.href);
    }
    if (REDIRECTS.has(res.status) && res.headers.location) {
      if (hop >= maxRedirects) throw new OutboundBlocked('redirect_limit', `more than ${maxRedirects} redirects`, url.href);
      redirects.push(url.href);
      url = new URL(res.headers.location, url);
      continue;
    }
    const body = res.body;
    return { ...res, url: url.href, address, redirects, text: () => body.toString('utf8') };
  }
}

async function vet(url: URL, deps: SafeFetchDeps, signal: AbortSignal): Promise<{ address: string; family: number }> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OutboundBlocked('scheme', 'only http and https are allowed', url.href);
  if (url.username || url.password) throw new OutboundBlocked('credentials', 'URLs with credentials are not allowed', url.href);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const entry = deps.allowlist.match(hostname);
  if (!entry) throw new OutboundBlocked('not_allowlisted', `${hostname} is not on this server's outbound allowlist; an administrator can add it`, url.href);
  if (entry.httpsOnly && url.protocol !== 'https:') throw new OutboundBlocked('https_required', `${hostname} is allowed over HTTPS only`, url.href);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!entry.ports.includes(port)) throw new OutboundBlocked('port', `port ${port} is not allowed for ${hostname}`, url.href);

  let addresses: { address: string; family: number }[];
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
  else {
    try {
      addresses = await raceAbort(deps.resolver(hostname), signal);
    } catch (error) {
      throw new OutboundBlocked(signal.aborted ? 'timeout' : 'dns', `could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`, url.href);
    }
  }
  if (!addresses.length) throw new OutboundBlocked('dns', `${hostname} has no addresses`, url.href);
  for (const { address } of addresses) {
    const verdict = classifyAddress(address);
    if (!verdict.public) throw new OutboundBlocked('private_address', `${hostname} resolves to ${address} (${verdict.reason}), which is not a public address`, url.href);
  }
  return addresses[0]!;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

const flat = (headers: IncomingHttpHeaders): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(', ') : v]])));

/** Node http(s) with the socket's DNS lookup pinned to the vetted address. */
export const nodeTransport: FetchTransport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const isHttps = req.url.protocol === 'https:';
    const hostname = req.url.hostname.replace(/^\[|\]$/g, '');
    const options = {
      method: 'GET',
      host: hostname,
      port: req.url.port || (isHttps ? 443 : 80),
      path: `${req.url.pathname}${req.url.search}`,
      headers: { host: req.url.host, ...req.headers },
      signal: req.signal,
      lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
        if (opts?.all) cb(null, [{ address: req.address, family: req.family }]);
        else cb(null, req.address, req.family);
      }) as never,
      ...(isHttps ? { servername: isIP(hostname) ? undefined : hostname } : {}),
    };
    const client = (isHttps ? httpsRequest : httpRequest)(options, (res) => {
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > req.maxBytes) {
        res.destroy();
        reject(new OutboundBlocked('too_large', `answer is ${declared} bytes, over the ${req.maxBytes}-byte limit`, req.url.href));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > req.maxBytes) {
          res.destroy();
          reject(new OutboundBlocked('too_large', `answer is over the ${req.maxBytes}-byte limit`, req.url.href));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: flat(res.headers), body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    client.on('error', reject);
    client.end();
  });
