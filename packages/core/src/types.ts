export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthReport {
  name: string;
  status: HealthStatus;
  details?: Record<string, unknown>;
}

/** Every module exposes a health check. */
export interface HealthCheckable {
  readonly name: string;
  health(): Promise<HealthReport>;
}

export type TradingMode = 'PAPER' | 'LIVE';
export type Timeframe = '5m' | '15m' | '30m' | '1h' | '4h';
