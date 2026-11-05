import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  apiGuard,
  clearSession,
  ipHash,
  isLoggedIn,
  LOCKOUT_MS,
  MAX_LOGIN_FAILURES,
  MIN_PASSWORD_LENGTH,
  PASSWORD_MISSING_HINT,
  PASSWORD_WEAK_HINT,
  purgeLoginFailures,
  setSession,
} from './auth';
import { appsRoutes } from './apps';
import type { AppEnv, Env } from './env';
import { handleAttribution } from './attribution';
import { handleBatch } from './ingest';
import { passwordsMatch } from './lib/crypto';

const app = new Hono<AppEnv>();

// The SDK API is called from apps (and Expo web), never with cookies: any origin, app key header only.
app.use('/api/v1/*', cors({ origin: '*', allowMethods: ['POST', 'GET', 'OPTIONS'], allowHeaders: ['X-App-Key', 'Content-Type'], maxAge: 86_400 }));

// Default-deny: every /api route needs a session unless it is on the allowlist in auth.ts.
app.use('/api/*', apiGuard);

// ---------- SDK ingestion (public to apiGuard; authenticates with X-App-Key)

app.post('/api/v1/batch', handleBatch);
app.get('/api/v1/attribution', handleAttribution);

// ---------- login

app.post('/api/auth/login', async (c) => {
  // Fail closed: no password, or a weak one, means nobody can log in.
  const adminPassword = c.env.ADMIN_PASSWORD;
  if (!adminPassword) return c.json({ error: PASSWORD_MISSING_HINT }, 500);
  if (adminPassword.length < MIN_PASSWORD_LENGTH) return c.json({ error: PASSWORD_WEAK_HINT }, 500);

  // Lock an IP out after too many wrong passwords, so a public dashboard can't be brute-forced.
  // Only a keyed hash of the IP is stored, never the address.
  const ipKey = await ipHash(c.env, c.req.header('cf-connecting-ip') ?? 'unknown');
  const now = Date.now();
  const recent = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip_hash = ? AND ts > ?')
    .bind(ipKey, now - LOCKOUT_MS)
    .first<number>('n');
  if ((recent ?? 0) >= MAX_LOGIN_FAILURES) {
    return c.json({ error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
  }
  const { password } = await c.req.json<{ password?: unknown }>().catch(() => ({ password: undefined }));
  if (typeof password !== 'string' || !password || !(await passwordsMatch(password, adminPassword))) {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO login_failures (ip_hash, ts) VALUES (?, ?)').bind(ipKey, now),
      c.env.DB.prepare('DELETE FROM login_failures WHERE ts < ?').bind(now - LOCKOUT_MS),
    ]);
    await new Promise((r) => setTimeout(r, 500));
    return c.json({ error: 'Wrong password' }, 401);
  }
  await c.env.DB.prepare('DELETE FROM login_failures WHERE ip_hash = ?').bind(ipKey).run();
  await setSession(c);
  return c.json({ ok: true });
});

app.post('/api/auth/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => c.json({ loggedIn: await isLoggedIn(c) }));

// ---------- dashboard API (login required by apiGuard)

app.route('/', appsRoutes);

// ---------- fallbacks

app.notFound((c) => c.json({ error: 'not found' }, 404));

// No stack traces in responses (spec §8, A02).
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});

async function scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  await purgeLoginFailures(env.DB, controller.scheduledTime);
  // Task 12: retry pending AdServices tokens and apply data retention.
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
