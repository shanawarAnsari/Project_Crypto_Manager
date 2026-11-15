import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from './logger';
import {
  ConfigError,
  DatabaseUnavailableError,
  ForbiddenConfigError,
  InstanceLockError,
  SunnyError,
} from './errors';

describe('createLogger', () => {
  it('redacts secrets', () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = createLogger({ level: 'info', name: 't', destination: dest });
    log.info({ apiSecret: 'topsecret', nested: { token: 'tok123' }, ok: 1 }, 'hello');
    const out = lines.join('');
    expect(out).not.toContain('topsecret');
    expect(out).not.toContain('tok123');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('"ok":1');
  });

  it('works with defaults', () => {
    expect(createLogger().level).toBe('info');
  });
});

describe('errors', () => {
  it('carry codes, names and causes', () => {
    const cause = new Error('root');
    const e = new DatabaseUnavailableError('db down', cause);
    expect(e).toBeInstanceOf(SunnyError);
    expect(e.code).toBe('DB_UNAVAILABLE');
    expect(e.name).toBe('DatabaseUnavailableError');
    expect(e.cause).toBe(cause);
    expect(new ConfigError('x', { a: 1 }).details).toEqual({ a: 1 });
    expect(new ForbiddenConfigError('x').code).toBe('CONFIG_FORBIDDEN');
    expect(new InstanceLockError('x').code).toBe('INSTANCE_LOCK_HELD');
  });
});
