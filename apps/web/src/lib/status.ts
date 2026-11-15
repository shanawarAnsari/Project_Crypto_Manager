export type StatusLevel = 'ok' | 'stale' | 'offline';

export interface EngineStatusInput {
  mode: 'PAPER' | 'LIVE';
  tradingEnabled: boolean;
  killSwitch: boolean;
  heartbeatAt: Date | null;
  clockOffsetMs: number | null;
  instanceId: string | null;
}

export interface EngineStatus {
  mode: 'PAPER' | 'LIVE';
  tradingEnabled: boolean;
  killSwitch: boolean;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  clockOffsetMs: number | null;
  instanceId: string | null;
  level: StatusLevel;
  serverTime: string;
}

/** `offline` = never beaten; `stale` = older than threshold (red banner). */
export function computeEngineStatus(
  row: EngineStatusInput | null,
  now: Date,
  staleAfterMs: number,
): EngineStatus {
  if (!row || !row.heartbeatAt) {
    return {
      mode: row?.mode ?? 'PAPER',
      tradingEnabled: row?.tradingEnabled ?? false,
      killSwitch: row?.killSwitch ?? false,
      heartbeatAt: null,
      heartbeatAgeMs: null,
      clockOffsetMs: row?.clockOffsetMs ?? null,
      instanceId: row?.instanceId ?? null,
      level: 'offline',
      serverTime: now.toISOString(),
    };
  }
  const age = Math.max(0, now.getTime() - row.heartbeatAt.getTime());
  return {
    mode: row.mode,
    tradingEnabled: row.tradingEnabled,
    killSwitch: row.killSwitch,
    heartbeatAt: row.heartbeatAt.toISOString(),
    heartbeatAgeMs: age,
    clockOffsetMs: row.clockOffsetMs,
    instanceId: row.instanceId,
    level: age > staleAfterMs ? 'stale' : 'ok',
    serverTime: now.toISOString(),
  };
}

export function formatAge(ms: number | null): string {
  if (ms === null) return 'never';
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
