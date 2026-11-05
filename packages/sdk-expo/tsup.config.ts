import { defineConfig } from 'tsup';

// @appdash/shared is a private workspace package: bundle its code and inline its types,
// so the published package has no dependency on it. Peer dependencies stay external.
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'build',
  format: ['cjs', 'esm'],
  target: 'es2020',
  platform: 'neutral',
  external: ['react', 'react-native', 'expo-router', 'expo-linking', /^expo(-.*)?$/, /^@react-native/],
  noExternal: ['@appdash/shared'],
  dts: { resolve: ['@appdash/shared', /^\.\.?\//] },
  sourcemap: true,
  clean: true,
});
