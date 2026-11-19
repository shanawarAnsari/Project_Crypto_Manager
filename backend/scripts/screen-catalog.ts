import { runBacktest } from "../src/desk/backtest.js";
import { strategies } from "../src/desk/catalog.js";
import { fetchHistory } from "../src/desk/history.js";

// Fixed windows, no tuning between them. Uses public prices only; never loads .env.
async function main() {
  const rows: { instrument: string; window: string; id: string; trades: number; return_pct: number; drawdown_pct: number }[] = [];
  for (const [window, startDate, endDate] of [
    ["selection", "2026-03-01", "2026-04-01"], ["holdout", "2026-10-01", "2026-11-01"]
  ] as const) {
    for (const instrument of ["BTCUSD", "ETHUSD"]) {
      const range = { instrument, resolution: "5m" as const, start: Date.parse(startDate) / 1000, end: Date.parse(endDate) / 1000 };
      const bars = await fetchHistory(range);
      for (const { id } of strategies) {
        const { stats } = await runBacktest({ ...range, strategyId: id, feeBps: 5.9, slippageBps: 2, spreadBps: 1 }, bars, 10000);
        rows.push({ instrument, window, id, trades: stats.trades, return_pct: stats.return_pct, drawdown_pct: stats.max_drawdown_pct });
      }
    }
  }
  const summaries = ["BTCUSD", "ETHUSD"].map(instrument => {
    const selection = rows.filter(r => r.instrument === instrument && r.window === "selection");
    const holdout = rows.filter(r => r.instrument === instrument && r.window === "holdout");
    const best = selection.slice().sort((a, b) => b.return_pct - a.return_pct || a.id.localeCompare(b.id))[0]!;
    const positive = new Set(selection.filter(r => r.return_pct > 0).map(r => r.id));
    return { instrument, selectionPositive: positive.size, holdoutPositive: holdout.filter(r => r.return_pct > 0).length,
      positiveBoth: holdout.filter(r => r.return_pct > 0 && positive.has(r.id)).length, best,
      selectedOnHoldout: holdout.find(r => r.id === best.id) };
  });
  console.log(JSON.stringify({ candidates: strategies.length, summaries, rows }, null, 2));
}
void main().catch((err: unknown) => { console.error(err); process.exitCode = 1; });
