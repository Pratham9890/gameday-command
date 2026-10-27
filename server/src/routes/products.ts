import type { Hono } from 'hono';
import type { Platform } from '../platform/platform.ts';
import type { AppEnv } from '../platform/http.ts';

/** ICS forms, the Event Action Plan, sitrep, GIS, CAP and AAR/IP exports. Filled in with the products milestone. */
export function addProductRoutes(_app: Hono<AppEnv>, _platform: Platform): void {}
