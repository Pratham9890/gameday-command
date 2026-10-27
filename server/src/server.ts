import { readFileSync, existsSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { openDb, type Db } from './db.ts';
import { createApp, platformOf } from './index.ts';
import { isLoopbackHost, loadConfig, type PlatformConfig } from './platform/config.ts';
import { createAdmin, type Platform, type PlatformOptions } from './platform/platform.ts';
import { EventHub, type HubOptions } from './events/hub.ts';

/**
 * Start the one server process: HTTP(S), the WebSocket hub, the weather feed,
 * and the built PWA when there is one (PLT-01). Used by `node
 * server/src/index.ts` and by the integration tests (port 0).
 */
export interface StartOptions extends PlatformOptions {
  db?: Db;
  config?: PlatformConfig;
  port?: number;
  host?: string;
  hub?: HubOptions;
}

export interface RunningServer {
  url: string;
  port: number;
  server: Server;
  platform: Platform;
  hub: EventHub;
  notes: string[];
  close(): Promise<void>;
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const config = opts.config ?? loadConfig();
  const dbPath = opts.dbPath ?? process.env.DB_PATH ?? './data/gameday.db';
  const db = opts.db ?? openDb(dbPath);
  const app = createApp(db, { ...opts, config, dbPath: opts.db ? opts.dbPath : dbPath });
  const platform = platformOf(app);
  const notes: string[] = [...config.warnings];

  if (config.bootstrap && platform.users.count() === 0 && !config.demo) {
    await createAdmin(platform, config.bootstrap, 'env');
    notes.push(`Created administrator "${config.bootstrap.username}" from GAMEDAY_ADMIN_USER. Remove GAMEDAY_ADMIN_PASSWORD from the environment now.`);
  }

  const host = opts.host ?? config.host;
  const mode = platform.authMode();
  if (!isLoopbackHost(host) && mode === 'setup') {
    throw new Error(
      `Refusing to listen on ${host} with no accounts: anyone on the network could use it. ` +
        'Create the first administrator (npm run admin:create, or GAMEDAY_ADMIN_USER and GAMEDAY_ADMIN_PASSWORD), or set GAMEDAY_DEMO=1 for a public demo.',
    );
  }
  if (!isLoopbackHost(host) && !config.tls && !config.secureCookies) notes.push(`Serving plain HTTP on ${host}: use TLS on a network (TLS_CERT_FILE, TLS_KEY_FILE; see docs/v3/deploy.md).`);
  if (mode === 'demo') notes.push('DEMO MODE (GAMEDAY_DEMO=1): no sign-in, synthetic data only, labelled as a demo everywhere.');
  if (mode === 'setup') notes.push('No accounts yet: the v2 routes answer loopback callers only, and /api/v3 waits for npm run admin:create.');
  notes.push(platform.weather.enabled ? `Weather feed on (NWS, contact ${config.feeds.contact}).` : 'Weather feed off (set GAMEDAY_FEED_CONTACT to turn on the NWS feed).');

  const staticDir = config.staticDir ?? (existsSync(resolve('app/dist/index.html')) ? 'app/dist' : null);
  if (staticDir && existsSync(resolve(staticDir))) {
    const files = serveStatic({ root: staticDir });
    const shell = serveStatic({ path: `${staticDir}/index.html` });
    // Never let a mistyped /api path fall through to the app shell.
    app.use('/*', (c, next) => (c.req.path.startsWith('/api/') ? next() : files(c, next)));
    app.get('*', (c, next) => (c.req.path.startsWith('/api/') ? next() : shell(c, next)));
    notes.push(`Serving the app from ${staticDir}.`);
  }

  const tls = config.tls ? { key: readFileSync(config.tls.keyFile), cert: readFileSync(config.tls.certFile), minVersion: 'TLSv1.2' as const } : null;
  const server = await new Promise<Server>((done, fail) => {
    const s = serve({
      fetch: app.fetch,
      port: opts.port ?? config.port,
      hostname: host,
      ...(tls ? { createServer: createHttpsServer, serverOptions: tls } : {}),
    }) as Server;
    s.once('listening', () => done(s));
    s.once('error', fail);
  });
  const hub = new EventHub(platform, opts.hub);
  hub.attach(server);
  platform.weather.start();

  const port = (server.address() as AddressInfo).port;
  const shownHost = host.includes(':') ? `[${host}]` : host;
  return {
    url: `${tls ? 'https' : 'http'}://${shownHost}:${port}`,
    port,
    server,
    platform,
    hub,
    notes,
    close: () =>
      new Promise<void>((done) => {
        platform.weather.stop();
        hub.close();
        server.close(() => done());
        server.closeAllConnections?.();
      }),
  };
}
