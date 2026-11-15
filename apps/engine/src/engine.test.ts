import { describe, expect, it, vi } from 'vitest';
import { createLogger, loadEngineConfig } from '@sunny/core';
import type { EngineStateRepository } from '@sunny/db';
import { createEngine } from './engine';

const log = createLogger({ level: 'silent' });
const config = loadEngineConfig({ DATABASE_URL: 'postgresql://x', HEALTH_PORT: '1' });

function repo(acquire: boolean): EngineStateRepository {
  return {
    ensure: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    tryAcquireLock: vi.fn().mockResolvedValue(acquire),
    heartbeat: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createEngine', () => {
  it('starts idle, serves health (db up/down) and releases the lock on stop', async () => {
    let dbUp = true;
    const r = repo(true);
    const engine = createEngine({
      config: { ...config, HEALTH_PORT: 0 },
      log,
      engineState: r,
      pingDb: async () => dbUp,
      onLockLost: vi.fn(),
      instanceId: 'i1',
    });
    const { healthPort } = await engine.start();
    const url = `http://127.0.0.1:${healthPort}/health`;
    expect((await fetch(url)).status).toBe(200);
    dbUp = false;
    expect((await fetch(url)).status).toBe(503);
    await engine.stop();
    expect(r.releaseLock).toHaveBeenCalledWith('i1');
  });

  it('a second engine is refused by the instance lock', async () => {
    const engine = createEngine({
      config: { ...config, HEALTH_PORT: 0 },
      log,
      engineState: repo(false),
      pingDb: async () => true,
      onLockLost: vi.fn(),
    });
    await expect(engine.start()).rejects.toMatchObject({ code: 'INSTANCE_LOCK_HELD' });
  });
});
