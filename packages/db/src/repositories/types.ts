export type TradingModeValue = 'PAPER' | 'LIVE';
export type CommandStatusValue = 'PENDING' | 'ACKED' | 'REJECTED';

export interface EngineStateRecord {
  id: number;
  mode: TradingModeValue;
  tradingEnabled: boolean;
  killSwitch: boolean;
  killSwitchReason: string | null;
  heartbeatAt: Date | null;
  clockOffsetMs: number | null;
  instanceId: string | null;
  instanceLockExpiresAt: Date | null;
  updatedAt: Date;
}

export interface EngineStateRepository {
  /** Creates the singleton row if missing. */
  ensure(): Promise<void>;
  get(): Promise<EngineStateRecord | null>;
  /** Atomically takes the single-instance lock; false if another live instance holds it. */
  tryAcquireLock(
    instanceId: string,
    ttlMs: number,
    now: Date,
    mode: TradingModeValue,
  ): Promise<boolean>;
  /** Renews lock + heartbeat; false means the lock was lost and the engine must stop. */
  heartbeat(
    instanceId: string,
    ttlMs: number,
    now: Date,
    clockOffsetMs?: number | null,
  ): Promise<boolean>;
  releaseLock(instanceId: string): Promise<void>;
}

export interface CommandRecord {
  id: string;
  type: string;
  payload: unknown;
  status: CommandStatusValue;
  requestedAt: Date;
  ackedAt: Date | null;
  result: unknown;
}

export interface CommandRepository {
  enqueue(type: string, payload?: unknown): Promise<CommandRecord>;
  listPending(limit?: number): Promise<CommandRecord[]>;
  ack(id: string, status: 'ACKED' | 'REJECTED', result?: unknown, now?: Date): Promise<void>;
}

export interface AuditLogEntry {
  actor: string;
  action: string;
  correlationId?: string;
  entity?: string;
  entityId?: string;
  details?: unknown;
}

export interface AuditLogRepository {
  append(entry: AuditLogEntry): Promise<void>;
}

export interface RiskEventEntry {
  rule: string;
  severity: string;
  correlationId?: string;
  details?: unknown;
}

export interface RiskEventRepository {
  create(entry: RiskEventEntry): Promise<void>;
}
