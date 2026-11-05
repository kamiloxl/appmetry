import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from './env';

/**
 * Generic 500 for anything uncaught (spec §8, A02). The response never carries a stack or message.
 * Only the route and the error message are logged: no request bodies, headers, cookies or query strings.
 */
export function onError(err: Error, c: Context<AppEnv>): Response {
  console.error({ route: `${c.req.method} ${c.req.path}`, message: err instanceof Error ? err.message : 'unknown error' });
  return c.json({ error: 'Internal error' }, 500);
}

export function notFound(c: Context<AppEnv>): Response {
  return c.json({ error: 'not found' }, 404);
}

/**
 * Headers for every response the Worker produces (API, webhooks, tracked-link redirects). Static dashboard files
 * are served by Cloudflare Assets and get theirs from apps/dashboard/public/_headers. No CSP here: these are JSON
 * or redirects, and a CSP would add nothing.
 */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  // Routes that set their own (tracked links send no-referrer) keep it.
  if (!c.res.headers.has('Referrer-Policy')) c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (new URL(c.req.url).protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000');
};
