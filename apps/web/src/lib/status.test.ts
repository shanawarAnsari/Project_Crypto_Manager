import { describe, expect, it } from 'vitest';
import { computeEngineStatus, formatAge, type EngineStatusInput } from './status';

const now = new Date('2026-01-01T00:00:30Z');
const row = (heartbeatAt: Date | null): EngineStatusInput => ({
  mode: 'PAPER',
  tradingEnabled: false,
  killSwitch: false,
  heartbeatAt,
  clockOffsetMs: 5,
  instanceId: 'abc',
});

describe('computeEngineStatus', () => {
  it('is ok for a fresh heartbeat', () => {
    const s = computeEngineStatus(row(new Date('2026-01-01T00:00:25Z')), now, 20_000);
    expect(s.level).toBe('ok');
    expect(s.heartbeatAgeMs).toBe(5000);
    expect(s.clockOffsetMs).toBe(5);
  });

  it('is stale beyond the threshold', () => {
    expect(computeEngineStatus(row(new Date('2026-01-01T00:00:00Z')), now, 20_000).level).toBe(
      'stale',
    );
  });

  it('is offline when no row or never beaten', () => {
    expect(computeEngineStatus(null, now, 20_000)).toMatchObject({
      level: 'offline',
      mode: 'PAPER',
    });
    expect(computeEngineStatus(row(null), now, 20_000)).toMatchObject({
      level: 'offline',
      instanceId: 'abc',
    });
  });

  it('never returns a negative age (clock skew)', () => {
    const s = computeEngineStatus(row(new Date('2026-01-01T00:01:00Z')), now, 20_000);
    expect(s.heartbeatAgeMs).toBe(0);
  });
});

describe('formatAge', () => {
  it('formats ranges', () => {
    expect(formatAge(null)).toBe('never');
    expect(formatAge(500)).toBe('<1s');
    expect(formatAge(5000)).toBe('5s');
    expect(formatAge(125_000)).toBe('2m 5s');
    expect(formatAge(3_900_000)).toBe('1h 5m');
  });
});
