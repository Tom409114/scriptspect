import { defineConfig } from 'tsup';

const version = process.env.npm_package_version ?? '0.0.0';

export default defineConfig({
  entry: { cli: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  define: { __PKG_VERSION__: JSON.stringify(version) },
});
