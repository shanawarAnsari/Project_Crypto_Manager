import { describe, expect, it } from 'vitest';
import { evaluate } from './index';

describe('risk-core skeleton', () => {
  it('fails closed: rejects everything until the engine exists', () => {
    const d = evaluate();
    expect(d.approved).toBe(false);
    expect(d.reasons).toContain('RISK_ENGINE_NOT_IMPLEMENTED');
  });
});
