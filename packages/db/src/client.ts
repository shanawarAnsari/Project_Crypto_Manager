import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __sunnyPrisma?: PrismaClient };

/** Shared client (cached across hot reloads in Next.js). */
export function getPrisma(databaseUrl?: string): PrismaClient {
  if (!globalForPrisma.__sunnyPrisma) {
    globalForPrisma.__sunnyPrisma = new PrismaClient(
      databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined,
    );
  }
  return globalForPrisma.__sunnyPrisma;
}

export async function pingDatabase(db: PrismaClient): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
