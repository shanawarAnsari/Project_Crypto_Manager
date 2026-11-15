import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };
export type DecimalValue = Decimal.Value;

export type Currency = 'INR' | 'USD';

/** Immutable money amount in a single currency. Never uses floats internally. */
export class Money {
  private constructor(
    readonly amount: Decimal,
    readonly currency: Currency,
  ) {}

  static of(amount: DecimalValue, currency: Currency): Money {
    return new Money(new Decimal(amount), currency);
  }

  static zero(currency: Currency): Money {
    return new Money(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSame(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  sub(other: Money): Money {
    this.assertSame(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  mul(factor: DecimalValue): Money {
    return new Money(this.amount.times(factor), this.currency);
  }

  div(divisor: DecimalValue): Money {
    const d = new Decimal(divisor);
    if (d.isZero()) throw new RangeError('Division by zero');
    return new Money(this.amount.div(d), this.currency);
  }

  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero();
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  /** Decimal string, safe for persistence. */
  toString(): string {
    return `${this.amount.toFixed()} ${this.currency}`;
  }

  private assertSame(other: Money): void {
    if (other.currency !== this.currency) {
      throw new TypeError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}

/** Rounds a quantity DOWN to the lot size; never rounds up (risk rule: reject, never round up). */
export function floorToStep(value: DecimalValue, step: DecimalValue): Decimal {
  const s = new Decimal(step);
  if (s.lte(0)) throw new RangeError('step must be positive');
  return new Decimal(value).div(s).floor().times(s);
}
