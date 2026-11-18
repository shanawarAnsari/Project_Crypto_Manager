import type { Bar } from "./types.js";

/** Contract details used for sizing; refreshed from Delta India product metadata when connected. */
export interface InstrumentSpec {
  symbol: string;
  /** Underlying units per contract (BTCUSD: 0.001 BTC). PnL per contract = price move x contractValue. */
  contractValue: number;
  tickSize: number;
  digits: number;
  minContracts: number;
  maxContracts: number;
  /** Whether this instrument uses trading-session checks; supported crypto instruments do not. */
  sessionsMatter: boolean;
  productId: number | null;
}

const DEFAULT_SPECS: Record<string, InstrumentSpec> = {
  BTCUSD: { symbol: "BTCUSD", contractValue: 0.001, tickSize: 0.1, digits: 1, minContracts: 1, maxContracts: 100_000, sessionsMatter: false, productId: null },
  ETHUSD: { symbol: "ETHUSD", contractValue: 0.01, tickSize: 0.05, digits: 2, minContracts: 1, maxContracts: 100_000, sessionsMatter: false, productId: null },
  SOLUSD: { symbol: "SOLUSD", contractValue: 1, tickSize: 0.001, digits: 3, minContracts: 1, maxContracts: 100_000, sessionsMatter: false, productId: null }
};

export const SPECS: Record<string, InstrumentSpec> = {};

export function specFor(symbol: string): InstrumentSpec {
  let spec = SPECS[symbol];
  if (!spec) {
    spec = { ...(DEFAULT_SPECS[symbol] ?? { ...DEFAULT_SPECS.BTCUSD!, symbol }) };
    SPECS[symbol] = spec;
  }
  return spec;
}

export function digitsForTick(tick: number): number {
  if (!(tick > 0)) return 2;
  const text = tick.toString();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.split(".")[1]!.length : 0;
}

export function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// Session windows in UTC hours [start, end)
export const SESSIONS_UTC: Record<string, [number, number]> = {
  ASIAN: [0, 7],
  LONDON: [7, 12],
  NEW_YORK: [12, 21]
};
const IST_OFFSET_MIN = 330;
export const DAY = 86_400;
export const FIVE_MIN = 300;

export function sessionFor(ts: number): string {
  const hour = new Date(ts * 1000).getUTCHours();
  for (const [name, [start, end]] of Object.entries(SESSIONS_UTC)) {
    if (hour >= start && hour < end) return name;
  }
  return "OFF_HOURS";
}

export function sessionInfo(ts: number): Record<string, unknown> {
  const d = new Date(ts * 1000);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  const ist = (minutes + IST_OFFSET_MIN) % 1440;
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    session: sessionFor(ts),
    utc: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    ist: `${pad(Math.floor(ist / 60))}:${pad(ist % 60)}`,
    day_progress: minutes / 1440,
    windows_utc: SESSIONS_UTC
  };
}

/** Aggregate bars into higher-timeframe buckets aligned to the UTC epoch (4h/1d align to midnight). */
export function resample(bars: readonly Bar[], seconds: number): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of bars) {
    const bucket = Math.floor(b.time / seconds) * seconds;
    if (!cur || cur.time !== bucket) {
      cur = { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  return out;
}

export type SwingPoint = [time: number, price: number];

/** Fractal swing highs/lows: a bar whose high (low) is the unique extreme of its left+right neighbours. */
export function swingPoints(bars: readonly Bar[], left = 2, right = 2): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let i = left; i < bars.length - right; i += 1) {
    const window = bars.slice(i - left, i + right + 1);
    const h = bars[i]!.high;
    const l = bars[i]!.low;
    const maxH = Math.max(...window.map((b) => b.high));
    const minL = Math.min(...window.map((b) => b.low));
    if (h === maxH && window.filter((b) => b.high === h).length === 1) highs.push([bars[i]!.time, h]);
    if (l === minL && window.filter((b) => b.low === l).length === 1) lows.push([bars[i]!.time, l]);
  }
  return { highs, lows };
}

/** Seeded PRNG (mulberry32) with a Gaussian helper so demo data and backtests are reproducible. */
export class Rng {
  private state: number;
  private spare: number | null = null;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  random(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.random() * (b - a + 1));
  }
  gauss(mu: number, sigma: number): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return mu + sigma * s;
    }
    let u = 0;
    while (u === 0) u = this.random();
    const v = this.random();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return mu + sigma * r * Math.cos(2 * Math.PI * v);
  }
}
