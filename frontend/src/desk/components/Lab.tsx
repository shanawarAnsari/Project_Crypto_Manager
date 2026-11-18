import { useEffect, useState } from "react";
import { api, dateTime, post, px, pnlClass, usd } from "../api";
import { pushToast, useDesk } from "../store";
import type { BacktestResult, JournalRow, TradeRow } from "../types";

function EquityCurve({ points }: { points: { time: number; equity: number }[] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points.map((p) => p.equity));
  const max = Math.max(...points.map((p) => p.equity));
  const d = points.map((p, i) => `${(i / (points.length - 1)) * 100},${max === min ? 50 : 96 - ((p.equity - min) / (max - min)) * 92}`).join(" ");
  const up = points.at(-1)!.equity >= points[0]!.equity;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-40 w-full rounded-md bg-black/20" aria-label="Backtest equity curve">
      <polyline points={d} fill="none" stroke={up ? "#35d39a" : "#f07178"} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function BacktestLab() {
  const instruments = useDesk((s) => s.instruments);
  const progress = useDesk((s) => s.backtestProgress);
  const [instrument, setInstrument] = useState("");
  const [source, setSource] = useState<"synthetic" | "delta">("delta");
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<BacktestResult | null>(null);
  const inst = instrument || instruments[0] || "BTCUSD";

  const run = async () => {
    setBusy(true);
    const r = await post<{ ok: boolean; message?: string } & Partial<BacktestResult>>("/api/backtest", { instrument: inst, days, source, seed: 42 })
      .catch(() => ({ ok: false, message: "Desk unreachable" }));
    if (r.ok) setRes(r as BacktestResult);
    else pushToast({ level: "error", title: "Backtest failed", message: r.message ?? "" });
    setBusy(false);
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="field"><span className="label">Instrument</span>
          <select value={inst} onChange={(e) => setInstrument(e.target.value)}>{instruments.map((i) => <option key={i}>{i}</option>)}</select>
        </label>
        <label className="field"><span className="label">History</span>
          <select value={source} onChange={(e) => setSource(e.target.value as "synthetic" | "delta")}>
            <option value="delta">Delta India (real 5M candles)</option>
            <option value="synthetic">Synthetic (planted sweeps)</option>
          </select>
        </label>
        <label className="field"><span className="label">Days</span>
          <input type="number" min={source === "delta" ? 3 : 10} max={source === "delta" ? 60 : 180} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </label>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run()}>{busy ? `Running… ${Math.round(progress * 100)}%` : "Run backtest"}</button>
        <p className="text-[11.5px] text-terminal-muted">Same Hunter, rule-based Analyst, AEGIS and paper engine as the live desk, using your current settings.</p>
      </div>
      {res && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            {([
              ["Net P/L", usd(res.stats.net_pnl), pnlClass(res.stats.net_pnl)], ["Return", `${res.stats.return_pct}%`, pnlClass(res.stats.return_pct)],
              ["Trades", String(res.stats.trades), ""], ["Win rate", `${res.stats.win_rate}%`, ""], ["Profit factor", String(res.stats.profit_factor), ""],
              ["Max DD", `${res.stats.max_drawdown_pct}%`, "text-terminal-red"], ["Avg win / loss", `${usd(res.stats.avg_win)} / ${usd(res.stats.avg_loss)}`, ""],
              ["Expectancy", usd(res.stats.expectancy), pnlClass(res.stats.expectancy)]
            ] as const).map(([k, v, c]) => <div key={k} className="kpi"><span className="label">{k}</span><b className={`num ${c || "text-terminal-text"}`}>{v}</b></div>)}
          </div>
          <EquityCurve points={res.equity_curve} />
          <div className="grid gap-4 md:grid-cols-3 text-[12px]">
            <div>
              <p className="label mb-1">Decisions</p>
              <p>{res.decisions.taken} taken · {res.decisions.vetoed} vetoed · {res.candles} candles · {res.elapsed_s}s</p>
              <p className="label mb-1 mt-3">Veto reasons</p>
              {Object.entries(res.veto_reasons).length ? Object.entries(res.veto_reasons).map(([k, v]) => <p key={k}>{k}: {v}</p>) : <p className="text-terminal-muted">None</p>}
            </div>
            <div>
              <p className="label mb-1">Monthly</p>
              {res.monthly.map((m) => <p key={m.month} className="num">{m.month}: <span className={pnlClass(m.pnl)}>{usd(m.pnl)} ({m.pct}%)</span></p>)}
            </div>
            <div className="max-h-48 overflow-y-auto">
              <p className="label mb-1">Last trades</p>
              {res.trades.slice(-25).reverse().map((t, i) => (
                <p key={i} className="num">{dateTime(t.time)} {t.direction} {px(t.entry)} → {px(t.exit)} <span className={pnlClass(t.pnl)}>{usd(t.pnl)}</span> <span className="text-terminal-muted">{t.reason}</span></p>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-terminal-muted">{res.disclaimer}</p>
        </>
      )}
    </div>
  );
}

export function Journal() {
  const tick = useDesk((s) => s.journalTick);
  const [outcome, setOutcome] = useState("");
  const [data, setData] = useState<{ decisions: JournalRow[]; trades: TradeRow[]; reviews: { day: string; text: string }[] } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    void api<NonNullable<typeof data>>(`/api/journal?limit=150${outcome ? `&outcome=${outcome}` : ""}`).then(setData).catch(() => undefined);
  }, [tick, outcome]);
  const review = async () => {
    const r = await post<{ ok: boolean; text: string }>("/api/review");
    if (r.ok) setData((d) => (d ? { ...d, reviews: [{ day: "today", text: r.text }, ...d.reviews] } : d));
  };
  return (
    <div className="grid gap-4 p-4 xl:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <p className="label">Decisions</p>
          {["", "taken", "vetoed", "skipped", "error"].map((o) => (
            <button key={o || "all"} type="button" className={`tab ${outcome === o ? "tab-on" : ""}`} onClick={() => setOutcome(o)}>{o || "all"}</button>
          ))}
        </div>
        <ul className="max-h-[420px] space-y-1.5 overflow-y-auto text-[12px]">
          {data?.decisions.map((r) => (
            <li key={r.id} className="rounded-md border border-white/[0.05] bg-black/20 px-3 py-2">
              <button type="button" className="w-full text-left" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <b>#{r.id} {r.instrument}</b> · <span className="text-terminal-muted">{dateTime(r.ts)}</span> · <span className="uppercase">{r.outcome}</span>
                <span className="block truncate text-terminal-muted">{r.summary}</span>
              </button>
              {open === r.id && (
                <ol className="mt-2 space-y-1 border-t border-white/[0.06] pt-2">
                  {r.trace.map((t, i) => <li key={i}><b>{t.agent}</b> <span className="text-terminal-muted">[{t.status}]</span> {t.summary}</li>)}
                </ol>
              )}
            </li>
          ))}
          {!data?.decisions.length && <li className="py-4 text-terminal-muted">No decisions journaled yet.</li>}
        </ul>
      </div>
      <div className="space-y-4">
        <div>
          <p className="label mb-2">Closed trades</p>
          <div className="max-h-[220px] overflow-y-auto">
            <table className="table">
              <thead><tr><th>Closed</th><th>Instrument</th><th>Side</th><th>Venue</th><th>Entry → Exit</th><th>P/L</th><th>Reason</th></tr></thead>
              <tbody>
                {data?.trades.map((t) => (
                  <tr key={t.id}>
                    <td>{t.closed_at ? dateTime(t.closed_at) : "—"}</td><td>{t.instrument}</td><td>{t.direction}</td><td>{t.venue}</td>
                    <td className="num">{px(t.entry)} → {px(t.exit)}</td><td className={`num ${pnlClass(t.pnl)}`}>{usd(t.pnl)}</td><td className="text-terminal-muted">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data?.trades.length && <p className="py-4 text-[12px] text-terminal-muted">No closed trades yet.</p>}
          </div>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between"><p className="label">Chronicler daily reviews</p><button type="button" className="btn text-xs" onClick={() => void review()}>Write review now</button></div>
          <ul className="max-h-[200px] space-y-2 overflow-y-auto text-[12.5px]">
            {data?.reviews.map((r, i) => <li key={`${r.day}-${i}`} className="rounded-md bg-black/20 p-3"><b className="text-terminal-muted">{r.day}</b><p>{r.text}</p></li>)}
            {!data?.reviews.length && <li className="text-terminal-muted">Reviews are written automatically at each UTC day change.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
