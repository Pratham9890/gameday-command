import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Platform } from './platform.ts';
import { type AppEnv, fail, SAFE_METHODS } from './http.ts';
import { securityHeaders } from './headers.ts';
import { installAuth, installLegacyGuard } from './middleware.ts';
import { addAuthRoutes } from '../routes/auth.ts';
import { addAdminRoutes } from '../routes/admin.ts';
import { addAuditRoutes } from '../routes/audit.ts';
import { addEventRoutes } from '../routes/events.ts';
import { addLibraryRoutes } from '../routes/library.ts';
import { addFeedRoutes } from '../routes/feeds.ts';
import { addProductRoutes } from '../routes/products.ts';

/**
 * Body limits by route. A decision batch carries every waiting agent's id
 * (100k with one agent per person), a package import a whole exercise, so
 * those get more room; everything else gets the default (1 MB).
 */
function limitFor(path: string, platform: Platform): number {
  const { defaultBytes, largeBytes } = platform.config.body;
  if (path === '/api/v3/packages/import') return largeBytes;
  if (path === '/api/decide' || path === '/api/history') return Math.max(defaultBytes, 8 * 1024 * 1024);
  if (path.startsWith('/api/v3/products/') || path.startsWith('/api/v3/documents') || path === '/api/v3/comparisons') return Math.max(defaultBytes, 4 * 1024 * 1024);
  return defaultBytes;
}

/** Install the security middleware and every /api/v3 route on an app. Call before the v2 routes. */
export function mountPlatform(app: Hono<AppEnv>, platform: Platform): void {
  app.use('*', securityHeaders({ tls: Boolean(platform.config.tls) || platform.config.secureCookies }));
  app.use('/api/*', async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const maxSize = limitFor(c.req.path, platform);
    return bodyLimit({ maxSize, onError: (ctx) => fail(ctx, 413, 'too_large', `Request bodies here may be at most ${Math.round(maxSize / 1024)} KB.`) })(c, next);
  });
  installAuth(app, platform);
  installLegacyGuard(app, platform);
  addAuthRoutes(app, platform);
  addAdminRoutes(app, platform);
  addAuditRoutes(app, platform);
  addEventRoutes(app, platform);
  addLibraryRoutes(app, platform);
  addFeedRoutes(app, platform);
  addProductRoutes(app, platform);

  app.notFound((c) => (c.req.path.startsWith('/api/') ? fail(c, 404, 'not_found', 'No such route.') : c.text('Not found', 404)));
  app.onError((error, c) => {
    console.error(`[gameday] ${c.req.method} ${c.req.path}:`, error);
    return fail(c, 500, 'internal', 'Internal server error.');
  });
}
