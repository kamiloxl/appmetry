// The Worker serves apps/dashboard/dist as static assets. Until the dashboard is built (or exists),
// write a placeholder page so `wrangler dev` and the server tests can start. dist/ is gitignored.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'dashboard', 'dist');
const index = join(dist, 'index.html');
if (!existsSync(index)) {
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    index,
    '<!doctype html><meta charset="utf-8"><title>appdash</title><p>The dashboard has not been built yet. Run <code>pnpm run build</code>.</p>\n',
  );
}
