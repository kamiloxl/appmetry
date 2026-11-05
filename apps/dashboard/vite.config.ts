import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The Worker serves dist/ as static assets (root wrangler.jsonc). public/_headers is copied into dist/ as-is.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    // `pnpm run dev` at the repo root runs the Worker on 8787.
    proxy: { '/api': 'http://localhost:8787', '/l': 'http://localhost:8787' },
  },
  test: { include: ['test/**/*.test.ts'] },
});
