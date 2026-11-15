import { describe, expect, it, vi } from 'vitest';
import {
  PrismaAuditLogRepository,
  PrismaCommandRepository,
  PrismaRiskEventRepository,
} from './misc.repository';

describe('PrismaCommandRepository', () => {
  it('enqueues with default empty payload', async () => {
    const command = { create: vi.fn().mockResolvedValue({ id: 'c1' }) };
    const rec = await new PrismaCommandRepository({ command } as never).enqueue('KILL_SWITCH_ON');
    expect(rec).toEqual({ id: 'c1' });
    expect(command.create).toHaveBeenCalledWith({ data: { type: 'KILL_SWITCH_ON', payload: {} } });
  });

  it('lists oldest pending first', async () => {
    const command = { findMany: vi.fn().mockResolvedValue([]) };
    await new PrismaCommandRepository({ command } as never).listPending(5);
    expect(command.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING' },
      orderBy: { requestedAt: 'asc' },
      take: 5,
    });
  });

  it('acks with status, result and timestamp', async () => {
    const command = { update: vi.fn().mockResolvedValue({}) };
    const now = new Date();
    await new PrismaCommandRepository({ command } as never).ack(
      'c1',
      'REJECTED',
      { why: 'x' },
      now,
    );
    expect(command.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: 'REJECTED', ackedAt: now, result: { why: 'x' } },
    });
  });

  it('ack() uses defaults', async () => {
    const command = { update: vi.fn().mockResolvedValue({}) };
    await new PrismaCommandRepository({ command } as never).ack('c1', 'ACKED');
    expect(command.update.mock.calls[0]![0].data.result).toEqual({});
  });
});

describe('PrismaAuditLogRepository / PrismaRiskEventRepository', () => {
  it('appends audit entries with default details', async () => {
    const auditLog = { create: vi.fn().mockResolvedValue({}) };
    await new PrismaAuditLogRepository({ auditLog } as never).append({
      actor: 'engine',
      action: 'start',
    });
    expect(auditLog.create.mock.calls[0]![0].data).toMatchObject({
      actor: 'engine',
      action: 'start',
      details: {},
    });
  });

  it('creates risk events', async () => {
    const riskEvent = { create: vi.fn().mockResolvedValue({}) };
    await new PrismaRiskEventRepository({ riskEvent } as never).create({
      rule: 'MAX_DAILY_LOSS',
      severity: 'critical',
      details: { pct: 2 },
    });
    expect(riskEvent.create.mock.calls[0]![0].data).toMatchObject({
      rule: 'MAX_DAILY_LOSS',
      details: { pct: 2 },
    });
  });

  it('risk event default details', async () => {
    const riskEvent = { create: vi.fn().mockResolvedValue({}) };
    await new PrismaRiskEventRepository({ riskEvent } as never).create({
      rule: 'r',
      severity: 's',
    });
    expect(riskEvent.create.mock.calls[0]![0].data.details).toEqual({});
  });
});
