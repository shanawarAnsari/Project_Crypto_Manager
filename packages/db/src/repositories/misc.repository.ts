import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  AuditLogEntry,
  AuditLogRepository,
  CommandRecord,
  CommandRepository,
  RiskEventEntry,
  RiskEventRepository,
} from './types';

export class PrismaCommandRepository implements CommandRepository {
  constructor(private readonly db: Pick<PrismaClient, 'command'>) {}

  async enqueue(type: string, payload: unknown = {}): Promise<CommandRecord> {
    return this.db.command.create({ data: { type, payload: payload as Prisma.InputJsonValue } });
  }

  async listPending(limit = 50): Promise<CommandRecord[]> {
    return this.db.command.findMany({
      where: { status: 'PENDING' },
      orderBy: { requestedAt: 'asc' },
      take: limit,
    });
  }

  async ack(
    id: string,
    status: 'ACKED' | 'REJECTED',
    result: unknown = {},
    now: Date = new Date(),
  ): Promise<void> {
    await this.db.command.update({
      where: { id },
      data: { status, ackedAt: now, result: result as Prisma.InputJsonValue },
    });
  }
}

export class PrismaAuditLogRepository implements AuditLogRepository {
  constructor(private readonly db: Pick<PrismaClient, 'auditLog'>) {}

  async append(entry: AuditLogEntry): Promise<void> {
    await this.db.auditLog.create({
      data: {
        actor: entry.actor,
        action: entry.action,
        correlationId: entry.correlationId,
        entity: entry.entity,
        entityId: entry.entityId,
        details: (entry.details ?? {}) as Prisma.InputJsonValue,
      },
    });
  }
}

export class PrismaRiskEventRepository implements RiskEventRepository {
  constructor(private readonly db: Pick<PrismaClient, 'riskEvent'>) {}

  async create(entry: RiskEventEntry): Promise<void> {
    await this.db.riskEvent.create({
      data: {
        rule: entry.rule,
        severity: entry.severity,
        correlationId: entry.correlationId,
        details: (entry.details ?? {}) as Prisma.InputJsonValue,
      },
    });
  }
}
