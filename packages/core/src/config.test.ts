import { describe, expect, it } from 'vitest';
import { assertDeltaIndiaUrl, loadEngineConfig } from './config';
import { ConfigError, ForbiddenConfigError } from './errors';

const base = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

describe('loadEngineConfig', () => {
  it('applies safe defaults (paper, testnet, India URL)', () => {
    const cfg = loadEngineConfig(base);
    expect(cfg.TRADING_MODE).toBe('PAPER');
    expect(cfg.APP_ENV).toBe('testnet');
    expect(cfg.DELTA_BASE_URL).toBe('https://api.india.delta.exchange');
    expect(cfg.HEALTH_PORT).toBe(8081);
  });

  it('coerces numeric env strings', () => {
    expect(loadEngineConfig({ ...base, HEALTH_PORT: '9000' }).HEALTH_PORT).toBe(9000);
  });

  it('rejects missing DATABASE_URL', () => {
    expect(() => loadEngineConfig({})).toThrow(ConfigError);
  });

  it('rejects invalid enum values', () => {
    expect(() => loadEngineConfig({ ...base, TRADING_MODE: 'YOLO' })).toThrow(ConfigError);
  });

  it('refuses the Delta Global URL', () => {
    expect(() =>
      loadEngineConfig({ ...base, DELTA_BASE_URL: 'https://api.delta.exchange' }),
    ).toThrow(ForbiddenConfigError);
  });

  it('refuses LIVE mode unless APP_ENV=live', () => {
    expect(() => loadEngineConfig({ ...base, TRADING_MODE: 'LIVE' })).toThrow(ForbiddenConfigError);
    expect(loadEngineConfig({ ...base, TRADING_MODE: 'LIVE', APP_ENV: 'live' }).TRADING_MODE).toBe(
      'LIVE',
    );
  });
});

describe('assertDeltaIndiaUrl', () => {
  it('accepts India and testnet hosts', () => {
    expect(() => assertDeltaIndiaUrl('https://api.india.delta.exchange')).not.toThrow();
    expect(() => assertDeltaIndiaUrl('https://testnet-api.india.delta.exchange')).not.toThrow();
  });
  it('is case-insensitive on the host', () => {
    expect(() => assertDeltaIndiaUrl('https://API.DELTA.EXCHANGE/v2')).toThrow(
      ForbiddenConfigError,
    );
  });
});
