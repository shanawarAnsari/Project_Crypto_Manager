import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceLockError, createLogger } from '@sunny/core';
import type { EngineStateRepository } from '@sunny/db';
import { HeartbeatService } from './heartbeat.service';

const log = createLogger({ level: 'silent' });

function repo(overrides: Partial<EngineStateRepository> = {}): EngineStateRepository {
  return {
    ensure: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    tryAcquireLock: vi.fn().mockResolvedValue(true),
    heartbeat: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const opts = (onLockLost = vi.fn()) => ({
  instanceId: 'me',
  mode: 'PAPER' as const,
  intervalMs: 1000,
  lockTtlMs: 5000,
  onLockLost,
});

describe('HeartbeatService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refuses to start when another instance holds the lock', async () => {
    const r = repo({ tryAcquireLock: vi.fn().mockResolvedValue(false) });
    const svc = new HeartbeatService(r, log, opts());
    await expect(svc.start()).rejects.toBeInstanceOf(InstanceLockError);
  });

  it('acquires the lock, beats periodically and releases on stop', async () => {
    const r = repo();
    const svc = new HeartbeatService(r, log, opts());
    await svc.start();
    expect(r.ensure).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(r.heartbeat).toHaveBeenCalledTimes(3);
    await svc.stop();
    expect(r.releaseLock).toHaveBeenCalledWith('me');
    await vi.advanceTimersByTimeAsync(3000);
    expect(r.heartbeat).toHaveBeenCalledTimes(3);
  });

  it('calls onLockLost once and goes down when the lock is lost', async () => {
    const onLockLost = vi.fn();
    const r = repo({ heartbeat: vi.fn().mockResolvedValue(false) });
    const svc = new HeartbeatService(r, log, opts(onLockLost));
    await svc.start();
    await svc.tick();
    await svc.tick();
    expect(onLockLost).toHaveBeenCalledTimes(1);
    expect((await svc.health()).status).toBe('down');
    await svc.stop();
  });

  it('survives transient DB errors, degrades when stale, recovers', async () => {
    const hb = vi.fn().mockRejectedValue(new Error('db down'));
    const r = repo({ heartbeat: hb });
    const svc = new HeartbeatService(r, log, opts());
    await svc.start();
    expect((await svc.health()).status).toBe('ok');
    await vi.advanceTimersByTimeAsync(4000);
    const degraded = await svc.health();
    expect(degraded.status).toBe('degraded');
    expect(degraded.details?.failures).toBe(4);
    hb.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await svc.health()).status).toBe('ok');
    await svc.stop();
  });

  it('logs but does not throw when release fails', async () => {
    const r = repo({ releaseLock: vi.fn().mockRejectedValue(new Error('x')) });
    const svc = new HeartbeatService(r, log, opts());
    await svc.start();
    await expect(svc.stop()).resolves.toBeUndefined();
  });

  it('reports degraded before start', async () => {
    const svc = new HeartbeatService(repo(), log, opts());
    const h = await svc.health();
    expect(h.status).toBe('degraded');
    expect(h.details?.lastOkAgeMs).toBeNull();
  });
});
