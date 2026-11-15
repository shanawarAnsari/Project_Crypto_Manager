import { describe, expect, it } from 'vitest';
import { Decimal, floorToStep, Money } from './money';

describe('Money', () => {
  it('adds without float error', () => {
    const a = Money.of('0.1', 'INR').add(Money.of('0.2', 'INR'));
    expect(a.amount.toFixed()).toBe('0.3');
  });

  it('subtracts, multiplies, divides', () => {
    const m = Money.of(100, 'USD');
    expect(m.sub(Money.of(40, 'USD')).amount.toFixed()).toBe('60');
    expect(m.mul('0.005').amount.toFixed()).toBe('0.5');
    expect(m.div(4).amount.toFixed()).toBe('25');
  });

  it('rejects currency mixing and division by zero', () => {
    expect(() => Money.of(1, 'INR').add(Money.of(1, 'USD'))).toThrow(TypeError);
    expect(() => Money.of(1, 'INR').sub(Money.of(1, 'USD'))).toThrow(TypeError);
    expect(() => Money.of(1, 'INR').div(0)).toThrow(RangeError);
  });

  it('reports sign, equality and string form', () => {
    expect(Money.of(-1, 'INR').isNegative()).toBe(true);
    expect(Money.zero('INR').isNegative()).toBe(false);
    expect(Money.of(1, 'INR').equals(Money.of('1.0', 'INR'))).toBe(true);
    expect(Money.of(1, 'INR').equals(Money.of(1, 'USD'))).toBe(false);
    expect(Money.of('12.50', 'INR').toString()).toBe('12.5 INR');
  });
});

describe('floorToStep', () => {
  it('rounds down, never up', () => {
    expect(floorToStep('0.0299', '0.001').toFixed()).toBe('0.029');
    expect(floorToStep('7', '2').toFixed()).toBe('6');
  });
  it('is exact for already-aligned values', () => {
    expect(floorToStep('0.3', '0.1').toFixed()).toBe('0.3');
    expect(new Decimal(floorToStep('1', '1')).toFixed()).toBe('1');
  });
  it('rejects non-positive step', () => {
    expect(() => floorToStep(1, 0)).toThrow(RangeError);
  });
});
