import { defineConfig, type Options } from 'tsup';

const version = process.env.npm_package_version ?? '0.0.0';

const shared: Options = {
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: false,
  outDir: 'dist',
  outExtension: () => ({ js: '.mjs' }),
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  define: { __PKG_VERSION__: JSON.stringify(version) },
};

export default defineConfig([
  {
    ...shared,
    name: 'cli',
    entry: { cli: 'src/main.ts' },
    clean: ['!action.mjs', '!action.mjs.map'],
  },
  {
    ...shared,
    name: 'action',
    entry: { action: 'src/action.ts' },
    clean: ['!cli.mjs', '!cli.mjs.map'],
    noExternal: ['fast-glob', 'yaml'],
    banner: {
      js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
    },
  },
]);
