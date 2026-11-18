/**
 * Synthetic 5M crypto market with session-aware volatility and planted liquidity sweeps.
 * Pre-rolls history, then emits one candle per orchestrator cycle. Each trading day it plans one stop-hunt
 * against the Asian range; `forceScenario` plants a textbook sweep immediately (for demos).
 */
import { DAY, FIVE_MIN, Rng, roundTo, sessionFor, specFor } from "./market.js";
import type { Bar } from "./types.js";

const BASE: Record<string, { price: number; vol: number; depthLo: number; depthHi: number; volBase: number }> = {
  BTCUSD: { price: 95_000, vol: 0.0011, depthLo: 0.18, depthHi: 0.34, volBase: 140 },
  ETHUSD: { price: 3_400, vol: 0.0014, depthLo: 0.18, depthHi: 0.34, volBase: 2_200 },
  SOLUSD: { price: 180, vol: 0.0018, depthLo: 0.18, depthHi: 0.34, volBase: 40_000 }
};
const SESSION_VOL: Record<string, number> = { ASIAN: 0.6, LONDON: 1.25, NEW_YORK: 1.35, OFF_HOURS: 0.5 };

interface SweepPlan {
  side: "high" | "low";
  level: number;
  success: boolean;
  phase: "approach" | "sweep" | "displace" | "follow";
  step: number;
  approachLen: number;
  followLen: number;
  depthFrac: number;
  startPrice: number;
}

export class DemoMarket {
  candles: Bar[] = [];
  plan: SweepPlan | null = null;
  private readonly rng: Rng;
  private readonly cfg: (typeof BASE)[string];
  private readonly digits: number;
  private readonly asia = new Map<number, [number, number, number]>();
  private dayTrigger: [number, number] | null = null;
  private readonly maxCandles: number;
  private t: number;
  private price: number;

  constructor(readonly instrument: string, opts: { seed?: number; historyDays?: number; maxCandles?: number; endTs?: number; startPrice?: number } = {}) {
    const seed = opts.seed ?? 7;
    this.rng = new Rng(seed + [...instrument].reduce((s, c) => s + c.charCodeAt(0) * 31, 0));
    this.cfg = BASE[instrument] ?? BASE.BTCUSD!;
    this.digits = specFor(instrument).digits;
    this.maxCandles = opts.maxCandles ?? 6000;
    const now = Math.floor((opts.endTs ?? Date.now() / 1000) / FIVE_MIN) * FIVE_MIN;
    let start = now - (opts.historyDays ?? 9) * DAY;
    start -= start % DAY;
    this.t = start;
    this.price = opts.startPrice ?? this.cfg.price;
    const n = (now - start) / FIVE_MIN;
    for (let k = 0; k < n; k += 1) this.step();
  }

  private absVol(price: number): number {
    return price * this.cfg.vol;
  }

  private r(x: number): number {
    return roundTo(x, this.digits);
  }

  private avgBody(n = 20): number {
    const tail = this.candles.slice(-n);
    if (!tail.length) return this.absVol(this.price);
    return tail.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / tail.length || this.absVol(this.price);
  }

  private depth(level: number, frac: number): number {
    return level * (this.cfg.depthLo + (this.cfg.depthHi - this.cfg.depthLo) * frac) / 100;
  }

  private margin(level: number): number {
    return level * 0.0006;
  }

  private asiaRange(dayStart: number): [number, number] | null {
    const e = this.asia.get(dayStart);
    return e && e[2] >= 6 ? [e[0], e[1]] : null;
  }

  private trackAsia(c: Bar): void {
    if (sessionFor(c.time) !== "ASIAN") return;
    const day = c.time - (c.time % DAY);
    const [hi, lo, n] = this.asia.get(day) ?? [c.high, c.low, 0];
    this.asia.set(day, [Math.max(hi, c.high), Math.min(lo, c.low), n + 1]);
    if (this.asia.size > 400) for (const k of [...this.asia.keys()].sort((a, b) => a - b).slice(0, 100)) this.asia.delete(k);
  }

  /** Plant a perfect sweep of the nearest mapped level on the correct side of price. */
  forceScenario(levels: Array<{ side: "high" | "low"; price: number }>): { side: "high" | "low"; level: number } | null {
    const price = this.price;
    const candidates = levels.filter((lv) => (lv.side === "high" && lv.price > price) || (lv.side === "low" && lv.price < price));
    if (!candidates.length) return null;
    const pick = candidates.reduce((a, b) => (Math.abs(b.price - price) < Math.abs(a.price - price) ? b : a));
    this.plan = { side: pick.side, level: pick.price, success: true, phase: "approach", step: 0, approachLen: 6, followLen: 22, depthFrac: 0.55, startPrice: price };
    return { side: pick.side, level: pick.price };
  }

  step(): Bar {
    const t = this.t;
    const sess = sessionFor(t);
    const dayStart = t - (t % DAY);
    this.maybePlan(t, dayStart, sess);
    const candle = this.plan ? this.planCandle(t) : this.randomCandle(t, sess, dayStart);
    this.candles.push(candle);
    this.trackAsia(candle);
    if (this.candles.length > this.maxCandles) this.candles = this.candles.slice(-(this.maxCandles - 1000));
    this.price = candle.close;
    this.t += FIVE_MIN;
    return candle;
  }

  spreadPct(): number {
    return this.rng.uniform(0.004, 0.02);
  }

  private maybePlan(t: number, dayStart: number, sess: string): void {
    if (this.plan || (sess !== "LONDON" && sess !== "NEW_YORK")) return;
    if (!this.dayTrigger || this.dayTrigger[0] !== dayStart) {
      this.dayTrigger = [dayStart, dayStart + this.rng.int(8 * 12, 17 * 12) * FIVE_MIN];
    }
    if (t !== this.dayTrigger[1]) return;
    const range = this.asiaRange(dayStart);
    if (!range) return;
    const [hi, lo] = range;
    const side = Math.abs(this.price - hi) < Math.abs(this.price - lo) ? "high" : "low";
    const level = side === "high" ? hi : lo;
    if ((side === "high" && this.price >= level) || (side === "low" && this.price <= level)) return;
    this.plan = { side, level, success: this.rng.random() < 0.64, phase: "approach", step: 0, approachLen: 8, followLen: 22, depthFrac: this.rng.random(), startPrice: this.price };
  }

  private volume(mult = 1): number {
    return Math.round(this.cfg.volBase * mult * this.rng.uniform(0.6, 1.4));
  }

  private mk(t: number, o: number, h: number, l: number, c: number, v: number): Bar {
    return { time: t, open: this.r(o), high: this.r(Math.max(h, o, c)), low: this.r(Math.min(l, o, c)), close: this.r(c), volume: v };
  }

  private randomCandle(t: number, sess: string, dayStart: number): Bar {
    const vol = this.absVol(this.price) * (SESSION_VOL[sess] ?? 1);
    const o = this.price;
    const range = sess === "LONDON" || sess === "NEW_YORK" ? this.asiaRange(dayStart) : null;
    // soft mean reversion toward the Asian mid during London/NY keeps planted sweeps clean
    const drift = range ? ((range[0] + range[1]) / 2 - o) * 0.04 : 0;
    let c = o + drift + this.rng.gauss(0, vol);
    let h = Math.max(o, c) + Math.abs(this.rng.gauss(0, vol * 0.6));
    let l = Math.min(o, c) - Math.abs(this.rng.gauss(0, vol * 0.6));
    if (range) {
      const m = this.margin(range[0]);
      if (o < range[0]) h = Math.min(h, range[0] - m);
      if (o > range[1]) l = Math.max(l, range[1] + m);
      c = Math.min(Math.max(c, l), h);
    }
    return this.mk(t, o, h, l, c, this.volume(SESSION_VOL[sess] ?? 1));
  }

  private planCandle(t: number): Bar {
    const p = this.plan!;
    const sign = p.side === "high" ? 1 : -1;
    const L = p.level;
    const m = this.margin(L);
    const o = this.price;
    const vol = this.absVol(o);
    if (p.phase === "approach") {
      p.step += 1;
      const target = L - sign * m * 2;
      let c = p.startPrice + (target - p.startPrice) * (p.step / p.approachLen) + this.rng.gauss(0, vol * 0.25);
      let h: number;
      let l: number;
      if (sign === 1) {
        c = Math.min(c, L - m);
        h = Math.min(Math.max(o, c) + Math.abs(this.rng.gauss(0, vol * 0.3)), L - m * 0.5);
        l = Math.min(o, c) - Math.abs(this.rng.gauss(0, vol * 0.3));
      } else {
        c = Math.max(c, L + m);
        l = Math.max(Math.min(o, c) - Math.abs(this.rng.gauss(0, vol * 0.3)), L + m * 0.5);
        h = Math.max(o, c) + Math.abs(this.rng.gauss(0, vol * 0.3));
      }
      if (p.step >= p.approachLen) {
        p.phase = "sweep";
        p.step = 0;
      }
      return this.mk(t, o, h, l, c, this.volume());
    }
    if (p.phase === "sweep") {
      const extreme = L + sign * this.depth(L, p.depthFrac);
      const c = L - sign * m * 0.6; // closes back just inside
      const [h, l] = sign === 1 ? [extreme, Math.min(o, c) - vol * 0.2] : [Math.max(o, c) + vol * 0.2, extreme];
      p.phase = "displace";
      return this.mk(t, o, h, l, c, this.volume(2.4));
    }
    if (p.phase === "displace") {
      const body = Math.max(this.avgBody() * 2.6, m * 3);
      const c = o - sign * body;
      let h = Math.max(o, c) + vol * 0.1;
      let l = Math.min(o, c) - vol * 0.1;
      if (sign === 1) h = Math.min(h, L - m * 0.3);
      else l = Math.max(l, L + m * 0.3);
      p.phase = "follow";
      p.step = 0;
      return this.mk(t, o, Math.max(h, o), Math.min(l, o), c, this.volume(2.8));
    }
    // follow-through: reversal works (success) or price runs back through the sweep (stop hit)
    p.step += 1;
    const direction = p.success ? -sign : sign;
    const c = o + direction * vol * this.rng.uniform(0.55, 1.25) + this.rng.gauss(0, vol * 0.35);
    const h = Math.max(o, c) + Math.abs(this.rng.gauss(0, vol * 0.4));
    const l = Math.min(o, c) - Math.abs(this.rng.gauss(0, vol * 0.4));
    if (p.step >= p.followLen) this.plan = null;
    return this.mk(t, o, h, l, c, this.volume(1.3));
  }
}

/** One DemoMarket per instrument with Scout-friendly accessors. */
export class DemoFeed {
  readonly markets: Record<string, DemoMarket> = {};
  constructor(instruments: readonly string[], seed = 7) {
    for (const s of instruments) this.markets[s] = new DemoMarket(s, { seed });
  }
  advance(): Record<string, Bar> {
    const out: Record<string, Bar> = {};
    for (const [s, m] of Object.entries(this.markets)) out[s] = m.step();
    return out;
  }
  candles(instrument: string, n = 2500): Bar[] {
    return this.markets[instrument]?.candles.slice(-n) ?? [];
  }
  spreadPct(instrument: string): number {
    return this.markets[instrument]?.spreadPct() ?? 0;
  }
  lastPrice(instrument: string): number {
    return this.markets[instrument]?.candles.at(-1)?.close ?? 0;
  }
  clock(): number {
    return Object.values(this.markets)[0]?.candles.at(-1)?.time ?? Math.floor(Date.now() / 1000);
  }
}
