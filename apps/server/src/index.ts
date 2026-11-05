import { Hono } from 'hono';
import { clearSession, isLoggedIn, MIN_PASSWORD_LENGTH, PASSWORD_MISSING_HINT, PASSWORD_WEAK_HINT, requireAuth, setSession } from './auth';
import type { AppEnv, Env } from './env';
import { passwordsMatch } from './lib/crypto';

const app = new Hono<AppEnv>();
const MAX_FAILURES = 10;
const LOCKOUT_MS = 15 * 60_000;

// ---------- login

app.post('/api/auth/login', async (c) => {
  // Fail closed: no password, or a weak one, means nobody can log in.
  const adminPassword = c.env.ADMIN_PASSWORD;
  if (!adminPassword) return c.json({ error: PASSWORD_MISSING_HINT }, 500);
  if (adminPassword.length < MIN_PASSWORD_LENGTH) return c.json({ error: PASSWORD_WEAK_HINT }, 500);

  // Lock an IP out after too many wrong passwords, so a public dashboard can't be brute-forced.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const now = Date.now();
  const recent = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND ts > ?')
    .bind(ip, now - LOCKOUT_MS)
    .first<number>('n');
  if ((recent ?? 0) >= MAX_FAILURES) {
    return c.json({ error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
  }
  const { password } = await c.req.json<{ password?: unknown }>().catch(() => ({ password: undefined }));
  if (typeof password !== 'string' || !password || !(await passwordsMatch(password, adminPassword))) {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO login_failures (ip, ts) VALUES (?, ?)').bind(ip, now),
      c.env.DB.prepare('DELETE FROM login_failures WHERE ts < ?').bind(now - LOCKOUT_MS),
    ]);
    await new Promise((r) => setTimeout(r, 500));
    return c.json({ error: 'Wrong password' }, 401);
  }
  await c.env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();
  await setSession(c);
  return c.json({ ok: true });
});

app.post('/api/auth/logout', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => c.json({ loggedIn: await isLoggedIn(c) }));

// ---------- dashboard API (login required)

app.use('/api/apps', requireAuth);
app.use('/api/apps/*', requireAuth);

// Task 5 lists the apps.
app.get('/api/apps', (c) => c.json([]));

// ---------- fallbacks

app.notFound((c) => c.json({ error: 'not found' }, 404));

// No stack traces in responses (spec §8, A02).
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal error' }, 500);
});

async function scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
  // Task 12: retry pending AdServices tokens and apply data retention.
}

export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
