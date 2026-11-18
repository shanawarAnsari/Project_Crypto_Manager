/**
 * Liquidity Sweep (stop-hunt reversal) strategy: level mapping and sweep detection.
 * Deterministic so the live desk, the backtester and the tests share exactly the same rules.
 */
import { DAY, resample, roundTo, sessionFor, specFor, swingPoints, type SwingPoint } from "./market.js";
import type { Bar, LiquidityLevel, Setup } from "./types.js";

export interface StrategyParams {
  min_depth_pct: number;
  max_depth_pct: number;
  displacement_mult: number;
  confirm_candles: number;
  sl_buffer_pct: number;
  tp1_rr: number;
  tp2_min_rr: number;
  body_lookback: number;
  volume_spike_mult: number;
  eq_tolerance_pct: number;
}

export const DEFAULT_PARAMS: Readonly<StrategyParams> = Object.freeze({
  min_depth_pct: 0.15,
  max_depth_pct: 0.4,
  displacement_mult: 1.2,
  confirm_candles: 3,
  sl_buffer_pct: 0.1,
  tp1_rr: 2.0,
  tp2_min_rr: 3.0,
  body_lookback: 20,
  volume_spike_mult: 1.5,
  eq_tolerance_pct: 0.05
});

const INT_PARAMS = new Set<keyof StrategyParams>(["confirm_candles", "body_lookback"]);

export function mergeParams(base: StrategyParams, values: Record<string, unknown>): StrategyParams {
  const next = { ...base };
  for (const [key, raw] of Object.entries(values)) {
    if (!(key in next)) continue;
    const num = Number(raw);
    if (!Number.isFinite(num)) continue;
    next[key as keyof StrategyParams] = INT_PARAMS.has(key as keyof StrategyParams) ? Math.round(num) : num;
  }
  return next;
}

export function validateParams(p: StrategyParams, minRr: number): string[] {
  const errors: string[] = [];
  if (!(p.min_depth_pct > 0) || p.min_depth_pct >= p.max_depth_pct) errors.push("Minimum sweep depth must be positive and below the maximum.");
  if (p.max_depth_pct > 5) errors.push("Maximum sweep depth cannot exceed 5%.");
  if (p.displacement_mult < 1) errors.push("Displacement multiplier must be at least 1.0x.");
  if (p.confirm_candles < 1 || p.confirm_candles > 10) errors.push("Confirmation candles must be between 1 and 10.");
  if (p.sl_buffer_pct < 0 || p.sl_buffer_pct > 2) errors.push("Stop buffer must be between 0% and 2%.");
  if (p.tp1_rr < minRr) errors.push(`TP1 RR cannot be below the Guardian's minimum (1:${minRr}).`);
  if (p.tp2_min_rr < p.tp1_rr) errors.push("TP2 minimum RR must be at least the TP1 RR.");
  if (p.body_lookback < 5 || p.body_lookback > 200) errors.push("Body lookback must be between 5 and 200 candles.");
  if (p.volume_spike_mult < 1) errors.push("Volume spike multiplier must be at least 1.0x.");
  if (p.eq_tolerance_pct <= 0 || p.eq_tolerance_pct > 1) errors.push("Equal-level tolerance must be between 0% and 1%.");
  return errors;
}

// ---------------------------------------------------------------- Cartographer
/** Map liquidity pools from 5M history: PDH/PDL, Asian range, 4H swings, equal highs/lows (15M). */
export function mapLiquidity(bars: readonly Bar[], params: StrategyParams = DEFAULT_PARAMS): LiquidityLevel[] {
  if (bars.length < 50) return [];
  const levels: LiquidityLevel[] = [];
  const lastTs = bars.at(-1)!.time;
  const today = lastTs - (lastTs % DAY);

  const prevDays = resample(bars, DAY).filter((d) => d.time < today);
  const pd = prevDays.at(-1);
  if (pd) {
    levels.push({ name: "PDH", price: pd.high, side: "high", strength: 2 });
    levels.push({ name: "PDL", price: pd.low, side: "low", strength: 2 });
  }

  const asiaDay = new Date(lastTs * 1000).getUTCHours() >= 7 ? today : today - DAY;
  const asia = bars.filter((b) => b.time >= asiaDay && b.time < asiaDay + 7 * 3600);
  if (asia.length >= 6) {
    levels.push({ name: "ASIA_HIGH", price: Math.max(...asia.map((b) => b.high)), side: "high", strength: 1 });
    levels.push({ name: "ASIA_LOW", price: Math.min(...asia.map((b) => b.low)), side: "low", strength: 1 });
  }

  const h4 = swingPoints(resample(bars, 4 * 3600), 2, 2);
  for (const [, p] of h4.highs.slice(-3)) levels.push({ name: "SWING_4H_HIGH", price: p, side: "high", strength: 1 });
  for (const [, p] of h4.lows.slice(-3)) levels.push({ name: "SWING_4H_LOW", price: p, side: "low", strength: 1 });

  const m15 = swingPoints(resample(bars.slice(-288), 900), 2, 2);
  const tol = bars.at(-1)!.close * params.eq_tolerance_pct / 100;
  levels.push(...equalClusters(m15.highs, tol, "high"), ...equalClusters(m15.lows, tol, "low"));
  return dedupe(levels, tol);
}

function equalClusters(points: SwingPoint[], tol: number, side: "high" | "low"): LiquidityLevel[] {
  const out: LiquidityLevel[] = [];
  const prices = points.slice(-12).map(([, p]) => p).sort((a, b) => a - b);
  let cluster: number[] = [];
  for (const p of prices) {
    if (cluster.length && p - cluster[0]! > tol) {
      if (cluster.length >= 2) out.push(eqLevel(cluster, side));
      cluster = [];
    }
    cluster.push(p);
  }
  if (cluster.length >= 2) out.push(eqLevel(cluster, side));
  return out;
}

function eqLevel(cluster: number[], side: "high" | "low"): LiquidityLevel {
  return {
    name: side === "high" ? "EQH" : "EQL",
    price: side === "high" ? Math.max(...cluster) : Math.min(...cluster),
    side,
    strength: cluster.length
  };
}

/** Merge same-side levels within tolerance, keeping the stronger one and combining names. */
function dedupe(levels: LiquidityLevel[], tol: number): LiquidityLevel[] {
  const out: LiquidityLevel[] = [];
  for (const lv of [...levels].sort((a, b) => b.strength - a.strength)) {
    const clash = out.find((o) => o.side === lv.side && Math.abs(o.price - lv.price) <= tol);
    if (clash) {
      if (!clash.name.includes(lv.name)) clash.name = `${clash.name}+${lv.name}`;
      clash.strength += lv.strength;
    } else {
      out.push({ ...lv });
    }
  }
  return out.sort((a, b) => a.price - b.price);
}

// ---------------------------------------------------------------- Hunter
export function depthPct(level: number, extreme: number): number {
  return Math.abs(extreme - level) / level * 100;
}

export function depthOk(depth: number, params: StrategyParams): boolean {
  return depth >= params.min_depth_pct && depth <= params.max_depth_pct;
}

/** Detect sweep setups whose displacement (confirmation) candle is bar `i`. */
export function detectAt(
  bars: readonly Bar[],
  i: number,
  levels: readonly LiquidityLevel[],
  instrument: string,
  params: StrategyParams = DEFAULT_PARAMS
): Setup[] {
  if (i < params.body_lookback + 8 || i >= bars.length) return [];
  const window = bars.slice(Math.max(0, i - params.body_lookback), i);
  let avgBody = window.length ? window.reduce((s, b) => s + Math.abs(b.close - b.open), 0) / window.length : 1e-9;
  if (!(avgBody > 0)) avgBody = 1e-9;
  const avgVol = (window.length ? window.reduce((s, b) => s + b.volume, 0) / window.length : 0) || 1;
  const cur = bars[i]!;
  const dispRatio = Math.abs(cur.close - cur.open) / avgBody;
  if (dispRatio < params.displacement_mult) return [];

  const strongBear = (b: Bar, L: number) => b.close < L && b.close < b.open && Math.abs(b.close - b.open) / avgBody >= params.displacement_mult;
  const strongBull = (b: Bar, L: number) => b.close > L && b.close > b.open && Math.abs(b.close - b.open) / avgBody >= params.displacement_mult;
  const digits = specFor(instrument).digits;
  const setups: Setup[] = [];

  for (const lv of levels) {
    const L = lv.price;
    for (let j = i; j > i - params.confirm_candles; j -= 1) {
      if (j < 7) break;
      const sweep = bars[j]!;
      const prior = bars.slice(j - 7, j);
      let pierced: boolean;
      let confirm: boolean;
      let earlier = false;
      if (lv.side === "high") {
        pierced = sweep.high > L && bars[j - 1]!.close < L && Math.max(...prior.map((b) => b.high)) <= L;
        confirm = cur.close < L && cur.close < cur.open;
        // earlier bars in the window must not have already confirmed (first close back inside)
        for (let k = j; k < i; k += 1) if (strongBear(bars[k]!, L)) earlier = true;
      } else {
        pierced = sweep.low < L && bars[j - 1]!.close > L && Math.min(...prior.map((b) => b.low)) >= L;
        confirm = cur.close > L && cur.close > cur.open;
        for (let k = j; k < i; k += 1) if (strongBull(bars[k]!, L)) earlier = true;
      }
      if (!(pierced && confirm) || earlier) continue;
      const span = bars.slice(j, i + 1);
      const extreme = lv.side === "high" ? Math.max(...span.map((b) => b.high)) : Math.min(...span.map((b) => b.low));
      const depth = depthPct(L, extreme);
      if (!depthOk(depth, params)) continue;
      const entry = cur.close;
      const buf = entry * params.sl_buffer_pct / 100;
      let direction: "LONG" | "SHORT";
      let sl: number;
      let risk: number;
      let tp1: number;
      let tp2: number;
      if (lv.side === "high") {
        direction = "SHORT";
        sl = extreme + buf;
        risk = sl - entry;
        tp1 = entry - params.tp1_rr * risk;
        const pools = levels.filter((x) => x.side === "low" && x.price < tp1).map((x) => x.price).sort((a, b) => b - a);
        tp2 = pools.find((p) => (entry - p) / risk >= params.tp2_min_rr) ?? entry - params.tp2_min_rr * risk;
      } else {
        direction = "LONG";
        sl = extreme - buf;
        risk = entry - sl;
        tp1 = entry + params.tp1_rr * risk;
        const pools = levels.filter((x) => x.side === "high" && x.price > tp1).map((x) => x.price).sort((a, b) => a - b);
        tp2 = pools.find((p) => (p - entry) / risk >= params.tp2_min_rr) ?? entry + params.tp2_min_rr * risk;
      }
      if (!(risk > 0)) continue;
      setups.push({
        signal_id: `${instrument}-${lv.name}-${sweep.time}`,
        instrument,
        direction,
        level: { ...lv },
        sweep_time: sweep.time,
        confirm_time: cur.time,
        sweep_extreme: roundTo(extreme, digits),
        extension_depth: roundTo(depth, 3),
        extension_unit: "pct",
        displacement_ratio: roundTo(dispRatio, 2),
        volume_spike: Math.max(sweep.volume, cur.volume) > params.volume_spike_mult * avgVol,
        entry_price: roundTo(entry, digits),
        stop_loss: roundTo(sl, digits),
        take_profit_1: roundTo(tp1, digits),
        take_profit_2: roundTo(tp2, digits),
        risk_reward_ratio: roundTo(params.tp1_rr, 2),
        session: sessionFor(cur.time)
      });
      break; // one setup per level
    }
  }
  return setups;
}

export function detectLatest(bars: readonly Bar[], instrument: string, levels: readonly LiquidityLevel[], params: StrategyParams = DEFAULT_PARAMS): Setup[] {
  return detectAt(bars, bars.length - 1, levels, instrument, params);
}
