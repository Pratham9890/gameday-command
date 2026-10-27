import type { Db } from '../db.ts';
import type { AllowlistEntry } from '../types.ts';
import { iso } from '../platform/canonical.ts';

/**
 * The admin-managed list of hosts this server may call (PLT-14). Exact host
 * names, or `*.example.gov` for subdomains. IP literals may be listed but are
 * still refused if private: being on the list never makes an internal
 * address reachable.
 */
interface Row {
  host: string;
  ports: string;
  https_only: number;
  note: string;
  added_by: string;
  added_at: number;
}

export const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^\d{1,3}(\.\d{1,3}){3}$/;

/** Seeded on first run so the weather feed works once a contact is configured; an admin may remove it. */
export const DEFAULT_ALLOWLIST: Omit<AllowlistEntry, 'addedAt' | 'addedBy'>[] = [{ host: 'api.weather.gov', ports: [443], httpsOnly: true, note: 'NWS API (weather feed)' }];

const toEntry = (r: Row): AllowlistEntry => ({ host: r.host, ports: JSON.parse(r.ports) as number[], httpsOnly: Boolean(r.https_only), note: r.note, addedBy: r.added_by, addedAt: iso(r.added_at) });

export class Allowlist {
  private readonly db: Db;
  private readonly now: () => number;
  constructor(
    db: Db,
    now: () => number = Date.now,
  ) {
    this.db = db;
    this.now = now;
  }

  seedDefaults(): void {
    const seeded = this.db.prepare("select value from platform_meta where key = 'allowlist_seeded'").get();
    if (seeded) return;
    for (const entry of DEFAULT_ALLOWLIST) this.add({ ...entry, addedBy: 'system' });
    this.db.prepare("insert or replace into platform_meta (key, value) values ('allowlist_seeded', '1')").run();
  }

  list(): AllowlistEntry[] {
    return (this.db.prepare('select * from outbound_allowlist order by host').all() as unknown as Row[]).map(toEntry);
  }

  add(entry: { host: string; ports?: number[]; httpsOnly?: boolean; note?: string; addedBy: string }): AllowlistEntry {
    const host = entry.host.trim().toLowerCase();
    if (!HOST_PATTERN.test(host)) throw new Error('host must be a DNS name (optionally *.domain) or an IPv4 address');
    const httpsOnly = entry.httpsOnly ?? true;
    const ports = [...new Set(entry.ports?.length ? entry.ports : httpsOnly ? [443] : [443, 80])].filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
    this.db
      .prepare('insert or replace into outbound_allowlist (host, ports, https_only, note, added_by, added_at) values (?, ?, ?, ?, ?, ?)')
      .run(host, JSON.stringify(ports), httpsOnly ? 1 : 0, (entry.note ?? '').slice(0, 200), entry.addedBy, this.now());
    return this.match(host.replace(/^\*\./, 'x.'))!;
  }

  remove(host: string): boolean {
    return Number(this.db.prepare('delete from outbound_allowlist where host = ?').run(host.trim().toLowerCase()).changes) > 0;
  }

  match(hostname: string): AllowlistEntry | null {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    for (const entry of this.list()) {
      if (entry.host === host) return entry;
      if (entry.host.startsWith('*.') && host.endsWith(entry.host.slice(1)) && host.length > entry.host.length - 1) return entry;
    }
    return null;
  }
}
