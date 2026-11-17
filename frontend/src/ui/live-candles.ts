import type { Candle, StrategyTimeframe, Timeframe } from "../domain/types";

export const CHART_TIMEFRAMES: readonly Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"];
/** Candles re-fetched over REST after each live-stream (re)connect to fill any gap. */
export const LIVE_CATCH_UP_LIMIT = 50;
export const MAX_CHART_CANDLES = 1_000;

const STRATEGY_TIMEFRAMES: readonly StrategyTimeframe[] = ["1h", "4h", "1d", "1w"];

export function toStrategyTimeframe(timeframe: Timeframe): StrategyTimeframe {
  return (STRATEGY_TIMEFRAMES as readonly string[]).includes(timeframe) ? timeframe as StrategyTimeframe : "1h";
}

/**
 * Merges the latest candles into the loaded history: same-time candles are replaced (in-progress bar),
 * newer ones are appended, and history is capped. Returns the original array when nothing changed.
 */
export function mergeCandles(current: Candle[], updates: readonly Candle[], max = MAX_CHART_CANDLES): Candle[] {
  if (updates.length === 0) return current;
  const byTime = new Map<number, Candle>();
  for (const candle of current) byTime.set(candle.time, candle);
  let changed = false;
  for (const candle of updates) {
    const existing = byTime.get(candle.time);
    if (
      existing &&
      existing.open === candle.open &&
      existing.high === candle.high &&
      existing.low === candle.low &&
      existing.close === candle.close &&
      existing.volume === candle.volume
    ) {
      continue;
    }
    byTime.set(candle.time, candle);
    changed = true;
  }
  if (!changed) return current;
  const merged = [...byTime.values()].sort((left, right) => left.time - right.time);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}
