import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Workspace packages are TS source: bundle them. Runtime deps stay external (installed in the image).
  noExternal: [/^@sunny\//],
  external: ['@prisma/client', 'pino', 'zod', 'decimal.js'],
});
