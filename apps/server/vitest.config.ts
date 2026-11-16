import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      // The root config is the deployable unit (spec §2); tests use the same bindings.
      wrangler: { configPath: '../../wrangler.jsonc' },
      miniflare: {
        bindings: {
          ADMIN_PASSWORD: 'test-password-12',
          // Test-only key (32 bytes of 0x07, base64). Never used outside tests.
          INTEGRATIONS_KEY: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
          TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
        },
      },
    })),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Each wrong password waits 500 ms; the lockout test makes 11 attempts.
    testTimeout: 20_000,
  },
});
