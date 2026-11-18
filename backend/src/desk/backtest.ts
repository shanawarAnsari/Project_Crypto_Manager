/** Backtest Lab: replays history through the same Hunter + Analyst (rule-based) + Guardian + paper engine rules. */
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { mockDecision } from "./analyst.js";
import { DemoMarket } from "./demo-feed.js";
import { specFor } from "./market.js";
import { PaperEngine, round2 } from "./paper-engine.js";
import { evaluate, newGuardianState, type RiskRules } from "./risk.js";
import { detectAt, mapLiquidity, type StrategyParams } from "./strategy.js";
import type { Bar, LiquidityLevel } from "./types.js";

export interface BacktestResult {
  instrument: string;
  source: "synthetic" | "delta";
  days: number;
  candles: number;
  elapsed_s: number;
  stats: {
    trades: number; win_rate: number; profit_factor: number; max_drawdown_pct: number; net_pnl: number; return_pct: number;
    avg_win: number; avg_loss: number; expectancy: number; final_equity: number; starting_balance: number;
  };
  decisions: { taken: number; vetoed: number };
  veto_reasons: Record<string, number>;
  equity_curve: Array<{ time: number; equity: number }>;
  markers: Array<{ time: number; type: "entry" | "exit"; direction?: string; price?: number; pnl?: number; reason?: string | null; level?: string }>;
  monthly: Array<{ month: string; pnl: number; pct: number }>;
  trades: Array<{ time: number; closed: number; direction: string; entry: number; exit: number | null; pnl: number; reason: string | null }>;
  disclaimer: string;
}

export async function runBacktest(opts: {
  instrument: string;
  days: number;
  rules: RiskRules;
  params: StrategyParams;
  startingBalance: number;
  candles?: Bar[];
  seed?: number;
  typicalSpreadPct?: number;
  progress?: (x: number) => void;
}): Promise<BacktestResult> {
  const t0 = Date.now();
  const { instrument, rules, params } = opts;
  const bars = opts.candles ?? new DemoMarket(instrument, { seed: opts.seed ?? 42, historyDays: opts.days, maxCandles: opts.days * 288 + 2000 }).candles;
  const n = bars.length;
  const spec = specFor(instrument);
  const engine = new PaperEngine(opts.startingBalance, bars[0]?.time ?? 0);
  engine.equityCurve = [];
  const gs = newGuardianState();
  gs.day_start_equity = opts.startingBalance;
  let levels: LiquidityLevel[] = [];
  const markers: BacktestResult["markers"] = [];
  const decisions = { taken: 0, vetoed: 0 };
  const vetoReasons: Record<string, number> = {};
  const curve: Array<{ time: number; equity: number }> = [];
  const startI = 300;

  for (let i = startI; i < n; i += 1) {
    const c = bars[i]!;
    const day = new Date(c.time * 1000).toISOString().slice(0, 10);
    if (day !== gs.day_key) {
      gs.day_key = day;
      gs.day_start_equity = engine.equity();
    }
    for (const ev of engine.onCandle(instrument, c)) {
      if (ev.type === "sl" || ev.type === "stop" || ev.type === "tp2") {
        markers.push({ time: ev.position.closed_at ?? c.time, type: "exit", pnl: ev.position.realized_pnl, reason: ev.position.close_reason });
      }
    }
    if (i % 24 === 0 || !levels.length) levels = mapLiquidity(bars.slice(Math.max(0, i - 600), i - params.confirm_candles), params);
    for (const setup of detectAt(bars, i, levels, instrument, params)) {
      const dec = mockDecision(setup, params);
      const { checks, contracts } = evaluate(rules, gs, {
        instrument, direction: setup.direction, entry: setup.entry_price, stop: setup.stop_loss, tp1: setup.take_profit_1,
        confidence: dec.confidence_score, session: setup.session, spreadPct: opts.typicalSpreadPct ?? 0.01, equity: engine.equity(),
        availableMargin: engine.equity() - engine.usedMargin(rules.leverage), openTrades: engine.positions.size,
        instrumentHasPosition: false, signalId: setup.signal_id, levelKey: `${instrument}:${setup.level.name}`,
        candleHourUtc: new Date(c.time * 1000).getUTCHours(), analystBias: dec.bias, spec, now: c.time
      });
      gs.processed_ids.add(setup.signal_id);
      const failed = checks.filter((ch) => !ch.passed);
      if (failed.length) {
        decisions.vetoed += 1;
        for (const ch of failed) vetoReasons[ch.name] = (vetoReasons[ch.name] ?? 0) + 1;
        continue;
      }
      gs.recent_signals.set(`${instrument}:${setup.level.name}`, c.time);
      engine.open({ signalId: setup.signal_id, instrument, direction: setup.direction, volume: contracts, price: setup.entry_price, sl: setup.stop_loss, tp1: setup.take_profit_1, tp2: setup.take_profit_2, ts: c.time });
      decisions.taken += 1;
      markers.push({ time: c.time, type: "entry", direction: setup.direction, price: setup.entry_price, level: setup.level.name });
    }
    if (i % 12 === 0) curve.push({ time: c.time, equity: engine.equity() });
    if (i % 500 === 0) {
      opts.progress?.((i - startI) / Math.max(1, n - startI));
      await yieldToLoop();
    }
  }
  const last = bars.at(-1);
  if (last) {
    engine.closeAll({ [instrument]: last.close }, "End of test", last.time);
    curve.push({ time: last.time, equity: engine.equity() });
  }

  const trades = engine.closed;
  const pnls = trades.map((t) => t.realized_pnl);
  const winsArr = pnls.filter((p) => p > 0);
  const lossArr = pnls.filter((p) => p < 0);
  const grossWin = winsArr.reduce((s, p) => s + p, 0);
  const grossLoss = -lossArr.reduce((s, p) => s + p, 0);
  let peak = opts.startingBalance;
  let maxDd = 0;
  for (const pt of curve) {
    peak = Math.max(peak, pt.equity);
    if (peak) maxDd = Math.max(maxDd, (peak - pt.equity) / peak * 100);
  }
  const monthlyMap = new Map<string, number>();
  for (const t of trades) {
    const key = new Date((t.closed_at ?? t.opened_at) * 1000).toISOString().slice(0, 7);
    monthlyMap.set(key, (monthlyMap.get(key) ?? 0) + t.realized_pnl);
  }
  let eq = opts.startingBalance;
  const monthly = [...monthlyMap.keys()].sort().map((k) => {
    const pnl = monthlyMap.get(k)!;
    const row = { month: k, pnl: round2(pnl), pct: round2(pnl / eq * 100) };
    eq += pnl;
    return row;
  });
  const final = engine.equity();
  opts.progress?.(1);
  return {
    instrument, source: opts.candles ? "delta" : "synthetic", days: opts.days, candles: n, elapsed_s: round2((Date.now() - t0) / 1000),
    stats: {
      trades: trades.length,
      win_rate: pnls.length ? Math.round(winsArr.length / pnls.length * 1000) / 10 : 0,
      profit_factor: grossLoss ? round2(grossWin / grossLoss) : round2(grossWin),
      max_drawdown_pct: round2(maxDd),
      net_pnl: round2(final - opts.startingBalance),
      return_pct: round2((final - opts.startingBalance) / opts.startingBalance * 100),
      avg_win: round2(grossWin / Math.max(1, winsArr.length)),
      avg_loss: round2(-grossLoss / Math.max(1, lossArr.length)),
      expectancy: pnls.length ? round2(pnls.reduce((s, p) => s + p, 0) / pnls.length) : 0,
      final_equity: round2(final),
      starting_balance: opts.startingBalance
    },
    decisions, veto_reasons: vetoReasons, equity_curve: curve, markers, monthly,
    trades: trades.map((t) => ({ time: t.opened_at, closed: t.closed_at ?? 0, direction: t.direction, entry: t.entry_price, exit: t.exit_price, pnl: t.realized_pnl, reason: t.close_reason })),
    disclaimer: "Backtests on synthetic or historical data do not guarantee future results."
  };
}
