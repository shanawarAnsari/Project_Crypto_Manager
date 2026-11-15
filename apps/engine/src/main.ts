import { createLogger, loadEngineConfig } from '@sunny/core';
import { getPrisma, PrismaEngineStateRepository, pingDatabase } from '@sunny/db';
import { createEngine } from './engine';

async function main(): Promise<void> {
  const config = loadEngineConfig(process.env);
  const log = createLogger({ level: config.LOG_LEVEL, name: 'engine' });
  const prisma = getPrisma(config.DATABASE_URL);

  let shuttingDown = false;
  const engine = createEngine({
    config,
    log,
    engineState: new PrismaEngineStateRepository(prisma),
    pingDb: () => pingDatabase(prisma),
    onLockLost: () => void shutdown(1),
  });

  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await engine.stop();
      await prisma.$disconnect();
    } finally {
      process.exit(code);
    }
  }

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  try {
    await engine.start();
  } catch (error) {
    log.fatal({ err: error }, 'engine failed to start');
    await prisma.$disconnect();
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  // Config errors surface before the logger exists.
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
