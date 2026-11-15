export type ExchangeName = 'delta-india' | 'delta-testnet' | 'paper' | 'mock';

/**
 * Skeleton of the exchange boundary. Nothing outside this package may know Delta exists.
 * The full interface (products, candles, orders, streams) is defined in Prompt 2.
 */
export interface ExchangeAdapter {
  readonly name: ExchangeName;
  /** Exchange server time in epoch milliseconds. */
  getServerTime(): Promise<number>;
}

/** Deterministic adapter for tests. */
export class MockExchangeAdapter implements ExchangeAdapter {
  readonly name = 'mock' as const;

  constructor(private readonly fixedTimeMs: number = 0) {}

  async getServerTime(): Promise<number> {
    return this.fixedTimeMs;
  }
}
