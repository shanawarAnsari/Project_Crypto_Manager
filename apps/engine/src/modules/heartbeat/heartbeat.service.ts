import {
  InstanceLockError,
  type HealthCheckable,
  type HealthReport,
  type Logger,
} from '@sunny/core';
import type { EngineStateRepository, TradingModeValue } from '@sunny/db';

export interface HeartbeatOptions {
  instanceId: string;
  mode: TradingModeValue;
  intervalMs: number;
  lockTtlMs: number;
  now?: () => Date;
  /** Called when the lock is lost; the engine must stop trading (fail closed). */
  onLockLost: () => void;
}

/** Holds the single-instance lock and writes the heartbeat to engine_state. */
export class HeartbeatService implements HealthCheckable {
  readonly name = 'heartbeat';
  private timer: NodeJS.Timeout | undefined;
  private lastOkAt: number | undefined;
  private consecutiveFailures = 0;
  private lost = false;
  private readonly now: () => Date;

  constructor(
    private readonly repo: EngineStateRepository,
    private readonly log: Logger,
    private readonly options: HeartbeatOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<void> {
    await this.repo.ensure();
    const acquired = await this.repo.tryAcquireLock(
      this.options.instanceId,
      this.options.lockTtlMs,
      this.now(),
      this.options.mode,
    );
    if (!acquired) {
      throw new InstanceLockError('Another engine instance holds the lock; refusing to start', {
        instanceId: this.options.instanceId,
      });
    }
    this.lastOkAt = this.now().getTime();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.log.info({ instanceId: this.options.instanceId }, 'instance lock acquired');
  }

  async tick(): Promise<void> {
    if (this.lost) return;
    try {
      const ok = await this.repo.heartbeat(
        this.options.instanceId,
        this.options.lockTtlMs,
        this.now(),
      );
      if (!ok) {
        this.lost = true;
        this.log.fatal('instance lock lost; stopping');
        this.options.onLockLost();
        return;
      }
      this.lastOkAt = this.now().getTime();
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.log.error({ err: error, failures: this.consecutiveFailures }, 'heartbeat failed');
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    try {
      await this.repo.releaseLock(this.options.instanceId);
    } catch (error) {
      this.log.error({ err: error }, 'failed to release instance lock');
    }
  }

  async health(): Promise<HealthReport> {
    const staleAfter = this.options.intervalMs * 3;
    const age = this.lastOkAt === undefined ? Infinity : this.now().getTime() - this.lastOkAt;
    const status = this.lost ? 'down' : age > staleAfter ? 'degraded' : 'ok';
    return {
      name: this.name,
      status,
      details: {
        lastOkAgeMs: Number.isFinite(age) ? age : null,
        failures: this.consecutiveFailures,
      },
    };
  }
}
