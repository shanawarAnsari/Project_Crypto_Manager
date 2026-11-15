import type { Timeframe } from '@sunny/core';

export interface Candle {
  openTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface Signal {
  strategyId: string;
  symbol: string;
  timeframe: Timeframe;
  side: 'BUY' | 'SELL';
  candleTime: Date;
}

export interface StrategyContext {
  symbol: string;
  timeframe: Timeframe;
  /** Closed candles only, oldest first. Strategies must never see an open candle (no lookahead). */
  candles: readonly Candle[];
}

/** Skeleton; indicators and the EMA-trend strategy arrive in Prompt 3. */
export interface Strategy {
  readonly id: string;
  /** Number of closed candles required before the strategy may emit signals. */
  readonly warmUpCandles: number;
  onCandleClosed(context: StrategyContext): Signal | null;
}

/** True once enough closed candles exist for the strategy to act. */
export function isWarmedUp(strategy: Strategy, context: StrategyContext): boolean {
  return context.candles.length >= strategy.warmUpCandles;
}
