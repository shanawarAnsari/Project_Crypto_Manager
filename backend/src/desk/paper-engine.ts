/** Paper broker: fills at the given price; manages BE at 1R, 50% partial at TP1 and a trailing stop toward TP2. */
import { randomUUID } from "node:crypto";
import { roundTo, specFor } from "./market.js";
import type { Bar, Direction, Position } from "./types.js";

export interface PositionEvent {
  type: "be" | "tp1" | "sl" | "stop" | "tp2" | "manual";
  position: Position;
  reason?: string;
}

export class PaperEngine {
  balance: number;
  readonly positions = new Map<string, Position>();
  closed: Position[] = [];
  equityCurve: Array<{ time: number; equity: number }>;

  constructor(readonly startingBalance: number, now = Math.floor(Date.now() / 1000)) {
    this.balance = startingBalance;
    this.equityCurve = [{ time: now, equity: startingBalance }];
  }

  openPositions(instrument?: string): Position[] {
    return [...this.positions.values()].filter((p) => !instrument || p.instrument === instrument);
  }

  equity(): number {
    let unrealized = 0;
    for (const p of this.positions.values()) unrealized += p.unrealized_pnl;
    return round2(this.balance + unrealized);
  }

  usedMargin(leverage: number): number {
    let total = 0;
    for (const p of this.positions.values()) total += p.volume * specFor(p.instrument).contractValue * p.entry_price / leverage;
    return round2(total);
  }

  openRisk(): number {
    let total = 0;
    for (const p of this.positions.values()) {
      const loss = p.direction === "LONG" ? p.entry_price - p.stop_loss : p.stop_loss - p.entry_price;
      total += Math.max(0, loss) * p.volume * specFor(p.instrument).contractValue;
    }
    return round2(total);
  }

  open(x: { signalId: string; instrument: string; direction: Direction; volume: number; price: number; sl: number; tp1: number; tp2: number; ts: number }): Position {
    const pos: Position = {
      id: randomUUID().replaceAll("-", "").slice(0, 10), signal_id: x.signalId, instrument: x.instrument, direction: x.direction,
      volume: x.volume, initial_volume: x.volume, entry_price: x.price, stop_loss: x.sl, initial_stop: x.sl,
      take_profit_1: x.tp1, take_profit_2: x.tp2, opened_at: x.ts, status: "open", closed_at: null, exit_price: null,
      realized_pnl: 0, unrealized_pnl: 0, tp1_hit: false, breakeven: false, venue: "paper", close_reason: null
    };
    this.positions.set(pos.id, pos);
    return pos;
  }

  private pnl(pos: Position, price: number, volume: number): number {
    const sign = pos.direction === "LONG" ? 1 : -1;
    return (price - pos.entry_price) * sign * volume * specFor(pos.instrument).contractValue;
  }

  close(pos: Position, price: number, reason: string, ts: number): Position {
    const pnl = this.pnl(pos, price, pos.volume);
    this.balance += pnl;
    pos.realized_pnl = round2(pos.realized_pnl + pnl);
    pos.unrealized_pnl = 0;
    pos.status = "closed";
    pos.exit_price = price;
    pos.closed_at = ts;
    pos.close_reason = reason;
    this.positions.delete(pos.id);
    this.closed.push(pos);
    if (this.closed.length > 2000) this.closed = this.closed.slice(-1500);
    return pos;
  }

  closeAll(prices: Record<string, number>, reason: string, ts: number): Position[] {
    return [...this.positions.values()].map((p) => this.close(p, prices[p.instrument] ?? p.entry_price, reason, ts));
  }

  /** Apply one closed candle to open positions. Stops are assumed hit before targets inside the same candle. */
  onCandle(instrument: string, candle: Bar): PositionEvent[] {
    const events: PositionEvent[] = [];
    const ts = candle.time;
    for (const pos of [...this.positions.values()]) {
      if (pos.instrument !== instrument) continue;
      const spec = specFor(instrument);
      const long = pos.direction === "LONG";
      const r = Math.abs(pos.entry_price - pos.initial_stop);
      const adverse = long ? candle.low : candle.high;
      const favorable = long ? candle.high : candle.low;
      if ((long && adverse <= pos.stop_loss) || (!long && adverse >= pos.stop_loss)) {
        const reason = pos.breakeven && Math.abs(pos.stop_loss - pos.entry_price) < 1e-9 ? "Break-even stop" : pos.tp1_hit ? "Trailing stop" : "Stop loss";
        this.close(pos, pos.stop_loss, reason, ts);
        events.push({ type: reason === "Stop loss" ? "sl" : "stop", position: { ...pos }, reason });
        continue;
      }
      const reached = (lvl: number) => (long ? favorable >= lvl : favorable <= lvl);
      if (!pos.breakeven && reached(pos.entry_price + (long ? r : -r))) {
        pos.stop_loss = pos.entry_price;
        pos.breakeven = true;
        events.push({ type: "be", position: { ...pos } });
      }
      if (!pos.tp1_hit && reached(pos.take_profit_1)) {
        const half = Math.floor(pos.volume / 2);
        pos.tp1_hit = true;
        if (half >= spec.minContracts && half < pos.volume) {
          const pnl = this.pnl(pos, pos.take_profit_1, half);
          this.balance += pnl;
          pos.realized_pnl = round2(pos.realized_pnl + pnl);
          pos.volume -= half;
        }
        if (!pos.breakeven) pos.stop_loss = pos.entry_price;
        pos.breakeven = true;
        events.push({ type: "tp1", position: { ...pos } });
      }
      if (pos.tp1_hit) {
        const trail = long ? candle.close - r : candle.close + r;
        if ((long && trail > pos.stop_loss) || (!long && trail < pos.stop_loss)) pos.stop_loss = roundTo(trail, spec.digits);
      }
      if (reached(pos.take_profit_2)) {
        this.close(pos, pos.take_profit_2, "TP2", ts);
        events.push({ type: "tp2", position: { ...pos } });
        continue;
      }
      pos.unrealized_pnl = round2(this.pnl(pos, candle.close, pos.volume));
    }
    this.equityCurve.push({ time: ts, equity: this.equity() });
    if (this.equityCurve.length > 3000) this.equityCurve = this.equityCurve.slice(-2500);
    return events;
  }
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
