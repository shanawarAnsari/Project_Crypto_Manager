import type { PrismaClient } from '@prisma/client';
import type { EngineStateRecord, EngineStateRepository, TradingModeValue } from './types';

type Db = Pick<PrismaClient, 'engineState'>;

export class PrismaEngineStateRepository implements EngineStateRepository {
  constructor(private readonly db: Db) {}

  async ensure(): Promise<void> {
    await this.db.engineState.createMany({ data: [{ id: 1 }], skipDuplicates: true });
  }

  async get(): Promise<EngineStateRecord | null> {
    return this.db.engineState.findUnique({ where: { id: 1 } });
  }

  async tryAcquireLock(
    instanceId: string,
    ttlMs: number,
    now: Date,
    mode: TradingModeValue,
  ): Promise<boolean> {
    const { count } = await this.db.engineState.updateMany({
      where: {
        id: 1,
        OR: [
          { instanceId: null },
          { instanceId },
          { instanceLockExpiresAt: null },
          { instanceLockExpiresAt: { lt: now } },
        ],
      },
      data: {
        instanceId,
        instanceLockExpiresAt: new Date(now.getTime() + ttlMs),
        heartbeatAt: now,
        mode,
      },
    });
    return count === 1;
  }

  async heartbeat(
    instanceId: string,
    ttlMs: number,
    now: Date,
    clockOffsetMs?: number | null,
  ): Promise<boolean> {
    const { count } = await this.db.engineState.updateMany({
      where: { id: 1, instanceId },
      data: {
        heartbeatAt: now,
        instanceLockExpiresAt: new Date(now.getTime() + ttlMs),
        ...(clockOffsetMs === undefined ? {} : { clockOffsetMs }),
      },
    });
    return count === 1;
  }

  async releaseLock(instanceId: string): Promise<void> {
    await this.db.engineState.updateMany({
      where: { id: 1, instanceId },
      data: { instanceId: null, instanceLockExpiresAt: null },
    });
  }
}
