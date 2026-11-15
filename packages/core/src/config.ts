import { z } from 'zod';
import { ConfigError, ForbiddenConfigError } from './errors';

const GLOBAL_DELTA_HOSTS = ['api.delta.exchange', 'cdn.delta.exchange', 'socket.delta.exchange'];

const intFromEnv = (def: number) => z.coerce.number().int().positive().default(def);

export const engineConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['testnet', 'live']).default('testnet'),
  TRADING_MODE: z.enum(['PAPER', 'LIVE']).default('PAPER'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  HEALTH_PORT: intFromEnv(8081),
  HEARTBEAT_INTERVAL_MS: intFromEnv(5000),
  LOCK_TTL_MS: intFromEnv(30000),
  STALE_HEARTBEAT_MS: intFromEnv(20000),
  DELTA_BASE_URL: z.string().url().default('https://api.india.delta.exchange'),
});

export type EngineConfig = z.infer<typeof engineConfigSchema>;

/** Refuses any Delta Global endpoint: this system trades Delta Exchange India only. */
export function assertDeltaIndiaUrl(url: string): void {
  const host = new URL(url).hostname.toLowerCase();
  if (GLOBAL_DELTA_HOSTS.includes(host)) {
    throw new ForbiddenConfigError('Delta Global URL is forbidden; use Delta Exchange India', {
      host,
    });
  }
}

export function loadEngineConfig(env: Record<string, string | undefined>): EngineConfig {
  const parsed = engineConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration: ${issues.join('; ')}`, { issues });
  }
  const cfg = parsed.data;
  assertDeltaIndiaUrl(cfg.DELTA_BASE_URL);
  if (cfg.TRADING_MODE === 'LIVE' && cfg.APP_ENV !== 'live') {
    throw new ForbiddenConfigError('LIVE trading mode is only allowed when APP_ENV=live (VPS)', {
      appEnv: cfg.APP_ENV,
    });
  }
  return cfg;
}
