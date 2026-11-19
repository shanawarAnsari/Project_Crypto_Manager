import type { Bar } from "./types.js";

const families = {
  channel: "Channel breakout",
  sweep: "Failed channel breakout",
  envelope: "Volatility band re-entry",
  impulse: "Volume-backed impulse",
  pullback: "Trend pullback",
  weighted: "Volume-weighted mean reclaim",
  efficiency: "Directional efficiency momentum",
  exhaustion: "Range expansion exhaustion",
  inside: "Inside-bar trend breakout",
  coil: "Compressed range release",
  rejection: "Range-edge wick rejection",
  pressure: "Volume pressure continuation"
} as const;
type Family = keyof typeof families;

export const strategies = (Object.keys(families) as Family[]).flatMap(family =>
  [6, 8, 10, 12, 16, 20, 24, 32, 48].map(lookback => ({
    id: `${family}-${lookback}`, name: `${families[family]} (${lookback} bars)`, family, lookback
  }))
);
const byId = new Map(strategies.map(s => [s.id, s]));
export const strategyById = (id: string) => byId.get(id);

/** end is exclusive and must refer only to closed candles. Never inspect a later fill bar. */
export function evaluateCandidate(id: string, bars: readonly Bar[], end = bars.length): "long" | "short" | null {
  const strategy = strategyById(id);
  if (!strategy) throw new RangeError(`Unknown strategy: ${id}`);
  const n = strategy.lookback;
  if (!Number.isInteger(end) || end < n + 1 || end > bars.length) return null;
  const start = end - 1 - n;
  const first = bars[start]!, current = bars[end - 1]!, previous = bars[end - 2]!, prior = bars[end - 3]!;
  let high = -Infinity, low = Infinity, sum = 0, rangeSum = 0, volume = 0, priceVolume = 0;
  let mean = 0, m2 = 0, path = 0, pressure = 0;
  for (let i = start; i < end - 1; i++) {
    const b = bars[i]!;
    high = Math.max(high, b.high);
    low = Math.min(low, b.low);
    const range = b.high - b.low;
    rangeSum += range;
    sum += b.close;
    volume += b.volume;
    priceVolume += (b.high + b.low + b.close) / 3 * b.volume;
    if (range > 0) pressure += b.volume * (2 * b.close - b.high - b.low) / range;
    if (i > start) path += Math.abs(b.close - bars[i - 1]!.close);
    const delta = b.close - mean;
    mean += delta / (i - start + 1);
    m2 += delta * (b.close - mean);
  }
  const avg = sum / n, avgRange = rangeSum / n, width = high - low;
  const { open, close } = current;
  const body = close - open, range = current.high - current.low;
  if (!(avgRange > 0 && width > 0 && range > 0 && volume > 0 && current.volume > 0)) return null;
  const direction = (long: boolean, short: boolean) => long === short ? null : long ? "long" : "short";
  switch (strategy.family) {
    case "channel":
      return direction(close > high, close < low);
    case "sweep":
      return direction(current.low < low && close > low && body > 0, current.high > high && close < high && body < 0);
    case "envelope": {
      const band = 1.5 * Math.sqrt(m2 / n);
      return direction(previous.close < avg - band && close >= avg - band, previous.close > avg + band && close <= avg + band);
    }
    case "impulse":
      if (current.volume < 1.5 * volume / n) return null;
      return direction(body > avgRange && close > avg, -body > avgRange && close < avg);
    case "pullback":
      return direction(previous.close > avg && avg > first.close && current.low <= avg && close > previous.high,
        previous.close < avg && avg < first.close && current.high >= avg && close < previous.low);
    case "weighted": {
      const vwap = priceVolume / volume;
      return direction(previous.close < vwap && close > vwap && body > 0, previous.close > vwap && close < vwap && body < 0);
    }
    case "efficiency": {
      const move = previous.close - first.close;
      return direction(move > 0.6 * path && close > previous.high, -move > 0.6 * path && close < previous.low);
    }
    case "exhaustion":
      if (range < 1.75 * avgRange) return null;
      return direction(current.low < low && close > current.high - 0.25 * range, current.high > high && close < current.low + 0.25 * range);
    case "inside":
      if (previous.high > prior.high || previous.low < prior.low) return null;
      return direction(close > prior.high && close > avg, close < prior.low && close < avg);
    case "coil":
      if (previous.high - previous.low > 0.6 * avgRange || range <= avgRange) return null;
      return direction(close > previous.high && body > 0 && close > avg, close < previous.low && body < 0 && close < avg);
    case "rejection":
      return direction(current.low <= low + 0.1 * width && Math.min(open, close) - current.low > 0.55 * range,
        current.high >= high - 0.1 * width && current.high - Math.max(open, close) > 0.55 * range);
    case "pressure":
      return direction(pressure > 0.25 * volume && close > previous.high && body > 0,
        pressure < -0.25 * volume && close < previous.low && body < 0);
  }
}
