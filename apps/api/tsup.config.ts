import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  clean: true,
  // Workspace packages ship TypeScript source, so bundle them in.
  noExternal: [/^@bedex\//],
});
