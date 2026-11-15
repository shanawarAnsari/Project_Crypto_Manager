import { randomUUID } from 'node:crypto';
import type { EngineConfig, HealthCheckable, Logger } from '@sunny/core';
import type { EngineStateRepository } from '@sunny/db';
import { HealthServer } from './modules/health/index';
import { HeartbeatService } from './modules/heartbeat/index';

export interface EngineDeps {
  config: EngineConfig;
  log: Logger;
  engineState: EngineStateRepository;
  /** Probes DB reachability for the health endpoint. */
  pingDb: () => Promise<boolean>;
  onLockLost: () => void;
  instanceId?: string;
}

export interface Engine {
  start(): Promise<{ healthPort: number }>;
  stop(): Promise<void>;
}

export function createEngine(deps: EngineDeps): Engine {
  const { config, log } = deps;
  const instanceId = deps.instanceId ?? randomUUID();

  const heartbeat = new HeartbeatService(deps.engineState, log, {
    instanceId,
    mode: config.TRADING_MODE,
    intervalMs: config.HEARTBEAT_INTERVAL_MS,
    lockTtlMs: config.LOCK_TTL_MS,
    onLockLost: deps.onLockLost,
  });

  const database: HealthCheckable = {
    name: 'database',
    async health() {
      return { name: 'database', status: (await deps.pingDb()) ? 'ok' : 'down' };
    },
  };

  const health = new HealthServer([database, heartbeat], log);

  return {
    async start() {
      await heartbeat.start();
      const healthPort = await health.listen(config.HEALTH_PORT);
      log.info({ instanceId, mode: config.TRADING_MODE, healthPort }, 'engine started (idle)');
      return { healthPort };
    },
    async stop() {
      await health.close();
      await heartbeat.stop();
      log.info('engine stopped');
    },
  };
}
