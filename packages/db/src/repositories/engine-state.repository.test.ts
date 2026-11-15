import { describe, expect, it, vi } from 'vitest';
import { PrismaEngineStateRepository } from './engine-state.repository';

function fakeDb(count = 1) {
  const engineState = {
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
    findUnique: vi.fn().mockResolvedValue({ id: 1 }),
    updateMany: vi.fn().mockResolvedValue({ count }),
  };
  return { engineState };
}

const now = new Date('2026-01-01T00:00:00Z');

describe('PrismaEngineStateRepository', () => {
  it('ensure() creates the singleton idempotently', async () => {
    const db = fakeDb();
    await new PrismaEngineStateRepository(db as never).ensure();
    expect(db.engineState.createMany).toHaveBeenCalledWith({
      data: [{ id: 1 }],
      skipDuplicates: true,
    });
  });

  it('get() reads row 1', async () => {
    const db = fakeDb();
    expect(await new PrismaEngineStateRepository(db as never).get()).toEqual({ id: 1 });
    expect(db.engineState.findUnique).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('tryAcquireLock() only matches free, own or expired locks and sets mode + expiry', async () => {
    const db = fakeDb(1);
    const ok = await new PrismaEngineStateRepository(db as never).tryAcquireLock(
      'a',
      30_000,
      now,
      'PAPER',
    );
    expect(ok).toBe(true);
    const arg = db.engineState.updateMany.mock.calls[0]![0];
    expect(arg.where.OR).toEqual(
      expect.arrayContaining([
        { instanceId: null },
        { instanceId: 'a' },
        { instanceLockExpiresAt: { lt: now } },
      ]),
    );
    expect(arg.data.instanceLockExpiresAt).toEqual(new Date(now.getTime() + 30_000));
    expect(arg.data.mode).toBe('PAPER');
  });

  it('tryAcquireLock() returns false when another live instance holds it', async () => {
    const db = fakeDb(0);
    expect(
      await new PrismaEngineStateRepository(db as never).tryAcquireLock('b', 1000, now, 'PAPER'),
    ).toBe(false);
  });

  it('heartbeat() is scoped to the owner and optionally writes clock offset', async () => {
    const db = fakeDb(1);
    const repo = new PrismaEngineStateRepository(db as never);
    expect(await repo.heartbeat('a', 1000, now)).toBe(true);
    expect(db.engineState.updateMany.mock.calls[0]![0].where).toEqual({ id: 1, instanceId: 'a' });
    expect(db.engineState.updateMany.mock.calls[0]![0].data).not.toHaveProperty('clockOffsetMs');
    await repo.heartbeat('a', 1000, now, 12);
    expect(db.engineState.updateMany.mock.calls[1]![0].data.clockOffsetMs).toBe(12);
  });

  it('heartbeat() returns false when the lock was lost', async () => {
    const db = fakeDb(0);
    expect(await new PrismaEngineStateRepository(db as never).heartbeat('a', 1000, now)).toBe(
      false,
    );
  });

  it('releaseLock() clears only the owner lock', async () => {
    const db = fakeDb();
    await new PrismaEngineStateRepository(db as never).releaseLock('a');
    expect(db.engineState.updateMany).toHaveBeenCalledWith({
      where: { id: 1, instanceId: 'a' },
      data: { instanceId: null, instanceLockExpiresAt: null },
    });
  });
});
