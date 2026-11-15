import { describe, expect, it } from 'vitest';
import { MockExchangeAdapter } from './index';

describe('MockExchangeAdapter', () => {
  it('is deterministic', async () => {
    const a = new MockExchangeAdapter(1234);
    expect(a.name).toBe('mock');
    expect(await a.getServerTime()).toBe(1234);
    expect(await new MockExchangeAdapter().getServerTime()).toBe(0);
  });
});
