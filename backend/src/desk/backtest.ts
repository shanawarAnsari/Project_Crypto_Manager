import { setImmediate as yieldToLoop } from "node:timers/promises";
import { evaluateCandidate, strategyById } from "./catalog.js";
import { bracketPrices, MIN_FEE_BPS, MIN_SLIPPAGE_BPS } from "./candidate-policy.js";
import { HistoryError, intervals, type HistoryRange } from "./history.js";
import type { Bar } from "./types.js";

export interface LabRequest extends HistoryRange { strategyId: string; feeBps: number; slippageBps: number; spreadBps: number }
export const MIN_SPREAD_BPS = 1;
interface Position { time: number; side: 1 | -1; raw: number; entry: number; units: number; stop: number; target: number }
interface Fill { time: number; closed: number; direction: string; entry: number; exit: number; pnl: number; reason: string }
const round = (n: number) => Math.round(n * 100) / 100;

/** Replays validated contiguous public candles. Simulation only: no exchange or account dependencies. */
export async function runBacktest(opts: LabRequest, bars: readonly Bar[], startingBalance: number,
  progress?: (fraction: number) => void, signal?: AbortSignal) {
  const strategy = strategyById(opts.strategyId);
  if (!strategy) throw new HistoryError("Select a catalog strategy.", 400);
  if (bars.length < strategy.lookback + 2) throw new HistoryError("Not enough candles for this strategy's lookback plus a fill.", 422);
  if (!(Number.isFinite(startingBalance) && startingBalance > 0) ||
      ![opts.feeBps, opts.slippageBps, opts.spreadBps].every(x => Number.isFinite(x) && x <= 100) ||
      opts.feeBps < MIN_FEE_BPS || opts.slippageBps < MIN_SLIPPAGE_BPS || opts.spreadBps < MIN_SPREAD_BPS)
    throw new HistoryError("Invalid simulation balance or costs.", 400);
  const t0 = Date.now(), fee = opts.feeBps / 10000, slip = opts.slippageBps / 10000, halfSpread = opts.spreadBps / 20000;
  const curve = [{ time: opts.start, equity: startingBalance }], recent: Fill[] = [];
  const monthPnls = new Map<string, number>();
  const stride = Math.ceil(bars.length / 700), step = intervals[opts.resolution];
  let equity = startingBalance, peak = equity, maxDD = 0, gross = 0, fees = 0, slippage = 0, spread = 0;
  let count = 0, wins = 0, losses = 0, gain = 0, loss = 0, pos: Position | undefined;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (i % 2048 === 0) {
      await yieldToLoop();
      signal?.throwIfAborted();
      progress?.(i / bars.length);
    }
    if (!pos && equity > 0 && i > 0) {
      const direction = evaluateCandidate(strategy.id, bars, i); // Only bars before this open.
      if (direction) {
        const side = direction === "long" ? 1 : -1;
        const entry = b.open * (1 + side * (slip + halfSpread));
        // Fractional research units: at most 1x equity, with entry fee reserved.
        const units = equity / (entry * (1 + fee));
        pos = { time: b.time, side, raw: b.open, entry, units, ...bracketPrices(entry, direction) };
      }
    }
    if (pos) {
      const { side, stop, target, units, entry } = pos;
      const long = side === 1;
      let raw: number | undefined, reason = "";
      if (long ? b.open <= stop : b.open >= stop) { raw = b.open; reason = "Gap through stop"; }
      else if (long ? b.open >= target : b.open <= target) { raw = target; reason = "Target"; }
      else if (long ? b.low <= stop : b.high >= stop) { raw = stop; reason = "Stop"; } // Adverse ordering on ambiguous bars.
      else if (long ? b.high >= target : b.low <= target) { raw = target; reason = "Target"; }
      else if (i === bars.length - 1) { raw = b.close; reason = "End of range"; }
      if (raw !== undefined) {
        const exit = raw * (1 - side * (slip + halfSpread)), tradeFees = units * (entry + exit) * fee;
        const pnl = side * units * (exit - entry) - tradeFees;
        gross += side * units * (raw - pos.raw);
        fees += tradeFees;
        slippage += units * (pos.raw + raw) * slip;
        spread += units * (pos.raw + raw) * halfSpread;
        equity += pnl;
        count++;
        if (pnl > 0) { wins++; gain += pnl; }
        else if (pnl < 0) { losses++; loss -= pnl; }
        const month = new Date(b.time * 1000).toISOString().slice(0, 7);
        monthPnls.set(month, (monthPnls.get(month) ?? 0) + pnl);
        recent.push({ time: pos.time, closed: b.time, direction: long ? "long" : "short", entry, exit, pnl: round(pnl), reason });
        if (recent.length > 100) recent.shift();
        pos = undefined;
      }
    }
    const marked = pos ? equity + pos.side * pos.units * (b.close - pos.entry) - pos.units * pos.entry * fee : equity;
    peak = Math.max(peak, marked);
    maxDD = Math.max(maxDD, (peak - marked) / peak * 100);
    if ((i + 1) % stride === 0 || i === bars.length - 1) curve.push({ time: b.time + step, equity: round(marked) });
  }
  let balance = startingBalance;
  const monthly = [...monthPnls].map(([month, pnl]) => {
    const pct = round(pnl / balance * 100);
    balance += pnl;
    return { month, pnl: round(pnl), pct };
  });
  progress?.(1);
  return {
    ...opts, strategyName: strategy.name, source: "delta" as const, days: (opts.end - opts.start) / 86400,
    candles: bars.length, elapsed_s: round((Date.now() - t0) / 1000),
    stats: { trades: count, win_rate: count ? round(100 * wins / count) : 0, profit_factor: loss ? round(gain / loss) : null,
      max_drawdown_pct: round(maxDD), net_pnl: round(equity - startingBalance), return_pct: round((equity / startingBalance - 1) * 100),
      avg_win: wins ? round(gain / wins) : 0, avg_loss: losses ? round(-loss / losses) : 0,
      expectancy: count ? round((equity - startingBalance) / count) : 0, final_equity: round(equity), starting_balance: startingBalance,
      gross_pnl: round(gross), fees: round(fees), slippage: round(slippage), spread: round(spread) },
    decisions: { taken: count, vetoed: 0 }, veto_reasons: {}, equity_curve: curve, trades: recent, monthly,
    disclaimer: "Research simulation, not an order or evidence of future profit. Costs are estimates. Funding, order-book liquidity, contract rounding, latency and account risk filters are not modeled."
  };
}
export type BacktestResult = Awaited<ReturnType<typeof runBacktest>>;
