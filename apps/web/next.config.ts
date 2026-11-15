import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // Trace from the monorepo root so workspace packages are included in the standalone output.
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  transpilePackages: ['@sunny/core', '@sunny/db'],
  serverExternalPackages: ['@prisma/client', 'pino'],
  poweredByHeader: false,
};

export default config;
