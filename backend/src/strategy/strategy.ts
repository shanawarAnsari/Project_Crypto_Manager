import { ADX, ATR, BollingerBands, EMA, RSI } from "technicalindicators";
import Decimal from "decimal.js";
import type { Candle, StrategyName, Timeframe, TradingSignal } from "../domain.js";

const TREND_TIMEFRAMES: readonly Timeframe[] = ["1h", "4h", "1d", "1w"];

export function evaluateStrategy(
  strategy: StrategyName,
  candles: readonly Candle[],
  stopLossPercent = "1",
  marketContext: Partial<Record<Timeframe, readonly Candle[]>> = {}
): TradingSignal {
  const latest = candles.at(-1);
  const fallback: TradingSignal = {
    strategy,
    side: null,
    referencePrice: latest?.close ?? "0",
    stopPrice: null,
    confidence: 0,
    reason: strategy === "flat" ? "Flat strategy is selected" : "Insufficient market data"
  };
  if (strategy === "flat" || candles.length < 20 || !latest) return fallback;

  const values = candles.map((candle) => ({
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close)
  }));
  if (values.some(({ high, low, close }) =>
    !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) ||
    high <= 0 || low <= 0 || close <= 0 || high < low || close > high || close < low
  )) return fallback;
  const closes = values.map(({ close }) => close);
  const last = closes.at(-1)!;
  let side: "buy" | "sell" | null = null;
  let confidence = 0;
  let reason = "No entry condition met";
  let atrDistance: Decimal | null = null;

  if (strategy === "meanReversion") {
    const rsi = RSI.calculate({ values: closes, period: 14 }).at(-1);
    const bands = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }).at(-1);
    if (rsi !== undefined && bands && rsi <= 30 && last <= bands.lower) {
      side = "buy"; confidence = Math.min((30 - rsi) / 30, 1); reason = `RSI oversold (${rsi.toFixed(1)}) below lower Bollinger band`;
    } else if (rsi !== undefined && bands && rsi >= 70 && last >= bands.upper) {
      side = "sell"; confidence = Math.min((rsi - 70) / 30, 1); reason = `RSI overbought (${rsi.toFixed(1)}) above upper Bollinger band`;
    }
  } else if (strategy === "trendBreakout") {
    const aligned = TREND_TIMEFRAMES.map((timeframe) => {
      const frame = marketContext[timeframe];
      if (!frame || frame.length < 20) return null;
      const frameCloses = frame.map((candle) => Number(candle.close));
      if (frameCloses.some((value) => !Number.isFinite(value) || value <= 0)) return null;
      const fast = EMA.calculate({ values: frameCloses, period: 10 }).at(-1);
      const slow = EMA.calculate({ values: frameCloses, period: 20 }).at(-1);
      if (fast === undefined || slow === undefined) return null;
      return fast > slow ? "buy" : fast < slow ? "sell" : null;
    });
    const adx = ADX.calculate({
      period: 14,
      high: values.map(({ high }) => high),
      low: values.map(({ low }) => low),
      close: closes
    }).at(-1);
    const atr = ATR.calculate({
      period: 14,
      high: values.map(({ high }) => high),
      low: values.map(({ low }) => low),
      close: closes
    }).at(-1);
    const fast = EMA.calculate({ values: closes, period: 10 }).at(-1);
    if (aligned.every((direction) => direction === "buy") && adx && adx.adx >= 20 && fast !== undefined && last > fast) {
      side = "buy";
      confidence = Math.min(adx.adx / 50, 1);
      reason = `Multi-timeframe uptrend confirmed by ADX (${adx.adx.toFixed(1)})`;
    } else if (aligned.every((direction) => direction === "sell") && adx && adx.adx >= 20 && fast !== undefined && last < fast) {
      side = "sell";
      confidence = Math.min(adx.adx / 50, 1);
      reason = `Multi-timeframe downtrend confirmed by ADX (${adx.adx.toFixed(1)})`;
    }
    if (side && atr !== undefined && Number.isFinite(atr) && atr > 0) {
      atrDistance = new Decimal(String(atr)).mul("1.5");
    }
  } else if (strategy === "gridScalper") {
    const bands = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }).at(-1);
    if (bands && last <= bands.lower) {
      side = "buy"; confidence = Math.min((bands.lower - last) / last * 10, 1); reason = "Price reached lower volatility band";
    } else if (bands && last >= bands.upper) {
      side = "sell"; confidence = Math.min((last - bands.upper) / last * 10, 1); reason = "Price reached upper volatility band";
    }
  }

  if (!side) return { ...fallback, referencePrice: latest.close, reason };
  const price = new Decimal(latest.close);
  let stopDistance: Decimal;
  try {
    stopDistance = new Decimal(stopLossPercent).div(100);
  } catch {
    return { ...fallback, reason: "Stop-loss configuration is invalid" };
  }
  if (!stopDistance.isFinite() || stopDistance.lte(0) || stopDistance.gt("0.1")) {
    return { ...fallback, reason: "Stop-loss configuration is outside its safe range" };
  }
  const configuredDistance = price.mul(stopDistance);
  const boundedStopDistance = atrDistance
    ? Decimal.min(atrDistance, configuredDistance)
    : configuredDistance;
  const stopPrice = side === "buy"
    ? price.minus(boundedStopDistance)
    : price.plus(boundedStopDistance);
  return {
    strategy,
    side,
    referencePrice: price.toString(),
    stopPrice: stopPrice.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toString(),
    confidence: Math.max(0, Math.min(confidence, 1)),
    reason
  };
}

export function rebaseSignal(signal: TradingSignal, referencePrice: string, stopLossPercent: string): TradingSignal {
  if (!signal.side) return { ...signal, referencePrice };
  let price: Decimal;
  let stopDistance: Decimal;
  try {
    price = new Decimal(referencePrice);
    stopDistance = new Decimal(stopLossPercent).div(100);
  } catch {
    return { ...signal, side: null, stopPrice: null, reason: "Current price or stop-loss configuration is invalid" };
  }
  if (!price.isFinite() || price.lte(0) || !stopDistance.isFinite() || stopDistance.lte(0) || stopDistance.gt("0.1")) {
    return { ...signal, side: null, stopPrice: null, reason: "Current price or stop-loss configuration is outside its safe range" };
  }
  const stop = signal.side === "buy"
    ? price.mul(new Decimal(1).minus(stopDistance))
    : price.mul(new Decimal(1).plus(stopDistance));
  return {
    ...signal,
    referencePrice: price.toString(),
    stopPrice: stop.toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toString()
  };
}
