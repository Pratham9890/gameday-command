import type { MiddlewareHandler } from 'hono';

/**
 * Security headers on every response.
 *
 * The app's CSP allows only this origin, plus what the app needs to run:
 * `blob:` workers and media (the engine and vision workers, webcam and file
 * video), `wasm-unsafe-eval` for WebAssembly (the Rust engine, onnxruntime-web)
 * without allowing `eval` of JavaScript, and inline styles (React sets them
 * through the DOM; the risk is far below inline script, which stays banned).
 * Frames: none, either way. HSTS is sent only over TLS.
 *
 * Products (ICS forms and the like) are static documents with no script at
 * all, so their responses get a stricter policy that bans script outright.
 */
export function appCsp(host: string | undefined, tls: boolean, extraConnect: string[] = []): string {
  const sockets = host ? [`ws://${host}`, `wss://${host}`] : [];
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "connect-src 'self' " + [...sockets, ...extraConnect].join(' '),
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(tls ? ['upgrade-insecure-requests'] : []),
  ].join('; ').replace(/ ;/g, ';');
}

export const PRODUCT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function securityHeaders(opts: { tls: boolean; extraConnect?: string[] }): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    if (!h.has('content-security-policy')) h.set('content-security-policy', appCsp(c.req.header('host'), opts.tls, opts.extraConnect));
    h.set('x-content-type-options', 'nosniff');
    h.set('referrer-policy', 'no-referrer');
    h.set('x-frame-options', 'DENY');
    h.set('cross-origin-opener-policy', 'same-origin');
    h.set('cross-origin-resource-policy', 'same-origin');
    h.set('permissions-policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
    if (opts.tls) h.set('strict-transport-security', 'max-age=31536000');
    if (c.req.path.startsWith('/api/') && !h.has('cache-control')) h.set('cache-control', 'no-store');
  };
}
