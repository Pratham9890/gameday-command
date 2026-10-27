import { isIP } from 'node:net';

/**
 * Is an address on the public internet? Everything else — loopback, private
 * (RFC 1918, ULA), link-local (including cloud metadata at 169.254.169.254),
 * carrier-grade NAT, multicast, documentation and reserved ranges, and IPv6
 * forms that embed one of those IPv4 addresses (mapped, NAT64, 6to4) — is
 * refused for outbound requests (PLT-14).
 */
type Range = [base: number, bits: number, name: string];

const V4_BLOCKED: Range[] = [
  [ip4('0.0.0.0'), 8, 'this network'],
  [ip4('10.0.0.0'), 8, 'private'],
  [ip4('100.64.0.0'), 10, 'carrier-grade NAT'],
  [ip4('127.0.0.0'), 8, 'loopback'],
  [ip4('169.254.0.0'), 16, 'link-local'],
  [ip4('172.16.0.0'), 12, 'private'],
  [ip4('192.0.0.0'), 24, 'IETF protocol assignments'],
  [ip4('192.0.2.0'), 24, 'documentation'],
  [ip4('192.88.99.0'), 24, '6to4 relay'],
  [ip4('192.168.0.0'), 16, 'private'],
  [ip4('198.18.0.0'), 15, 'benchmarking'],
  [ip4('198.51.100.0'), 24, 'documentation'],
  [ip4('203.0.113.0'), 24, 'documentation'],
  [ip4('224.0.0.0'), 4, 'multicast'],
  [ip4('240.0.0.0'), 4, 'reserved'],
];

function ip4(text: string): number {
  const parts = text.split('.').map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inRange4(value: number, [base, bits]: Range): boolean {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return ((value & mask) >>> 0) === ((base & mask) >>> 0);
}

/** Eight 16-bit groups, or null. Accepts `::` and a dotted IPv4 tail. */
export function parseIpv6(text: string): number[] | null {
  let s = text.toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = ip4(last);
    tail = [v4 >>> 16, v4 & 0xffff];
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const left = head ? head.split(':').filter((g) => g !== '') : [];
  const right = rest !== undefined && rest !== '' ? rest.split(':').filter((g) => g !== '') : [];
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(0, fill)).fill('0'), ...right].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g))) return null;
  if (tail.length) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

export interface AddressVerdict {
  public: boolean;
  reason: string;
}

export function classifyAddress(address: string): AddressVerdict {
  const family = isIP(address.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  if (family === 4) {
    const value = ip4(address);
    const hit = V4_BLOCKED.find((range) => inRange4(value, range));
    return hit ? { public: false, reason: hit[2] } : { public: true, reason: 'public' };
  }
  if (family !== 6) return { public: false, reason: 'not an IP address' };
  const g = parseIpv6(address)!;
  const embedded = (hi: number, lo: number) => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
  if (g.every((x) => x === 0)) return { public: false, reason: 'unspecified' };
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return { public: false, reason: 'loopback' };
  // IPv4-mapped ::ffff:a.b.c.d and the deprecated IPv4-compatible ::a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const inner = classifyAddress(embedded(g[6]!, g[7]!));
    return inner.public && g[5] === 0xffff ? inner : { public: false, reason: `IPv4 in IPv6 (${inner.reason})` };
  }
  // NAT64 64:ff9b::/96 and local-use 64:ff9b:1::/48
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return { public: false, reason: 'local NAT64' };
    const inner = classifyAddress(embedded(g[6]!, g[7]!));
    return inner.public ? inner : { public: false, reason: `NAT64 (${inner.reason})` };
  }
  // 6to4 2002::/16 embeds an IPv4 address in groups 1-2
  if (g[0] === 0x2002) {
    const inner = classifyAddress(embedded(g[1]!, g[2]!));
    return inner.public ? inner : { public: false, reason: `6to4 (${inner.reason})` };
  }
  if ((g[0]! & 0xfe00) === 0xfc00) return { public: false, reason: 'unique local' };
  if ((g[0]! & 0xffc0) === 0xfe80) return { public: false, reason: 'link-local' };
  if ((g[0]! & 0xffc0) === 0xfec0) return { public: false, reason: 'site-local' };
  if ((g[0]! & 0xff00) === 0xff00) return { public: false, reason: 'multicast' };
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return { public: false, reason: 'discard' };
  if (g[0] === 0x2001 && g[1] === 0xdb8) return { public: false, reason: 'documentation' };
  if (g[0] === 0x2001 && g[1]! < 0x200) return { public: false, reason: 'IETF protocol assignments' };
  if ((g[0]! & 0xe000) !== 0x2000) return { public: false, reason: 'not global unicast' };
  return { public: true, reason: 'public' };
}

export const isPublicAddress = (address: string) => classifyAddress(address).public;
