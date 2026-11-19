import { useEffect, useRef, useState } from "react";
import { api, dateTime, post, px, pnlClass, usd } from "../api";
import { useDesk } from "../store";
import type { HistoricalBacktest, JournalRow, LabCoverage, LabStrategy, TradeRow } from "../types";

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utcStamp = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

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
  const [catalog, setCatalog] = useState<LabStrategy[]>([]);
  const [loadKey, reload] = useState(0);
  const [catalogError, setCatalogError] = useState("");
  const [strategyId, setStrategyId] = useState("");
  const [start, setStart] = useState(() => utcDate(Date.now() - 30 * 86400000));
  const [end, setEnd] = useState(() => utcDate(Date.now()));
  const [resolution, setResolution] = useState("5m");
  const [feeBps, setFeeBps] = useState("5.9"), [slippageBps, setSlippageBps] = useState("2");
  const [spreadBps, setSpreadBps] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ctl = useRef<AbortController | null>(null);
  const [res, setRes] = useState<HistoricalBacktest | null>(null);
  const inst = instrument || instruments[0] || "";
  const [coverage, setCoverage] = useState<LabCoverage | null>(null);
  const [coverageError, setCoverageError] = useState("");
  const [coverageAttempt, retryCoverage] = useState(0);
  const activeCoverage = coverage?.instrument === inst && coverage.resolution === resolution ? coverage : null;
  const today = utcDate(Date.now()), min = activeCoverage ? utcDate(activeCoverage.earliestStart * 1000) : "";
  useEffect(() => {
    const abort = new AbortController();
    setCatalogError("");
    void api<{ strategies: LabStrategy[] }>("/api/strategies", { signal: abort.signal })
      .then(({ strategies }) => { if (!abort.signal.aborted) setCatalog(strategies); })
      .catch(() => { if (!abort.signal.aborted) setCatalogError("Strategy catalog unavailable."); });
    return () => abort.abort();
  }, [loadKey]);
  useEffect(() => {
    setCoverageError(""); setCoverage(null);
    if (!inst) return;
    const abort = new AbortController();
    void api<LabCoverage>(`/api/lab/coverage?${new URLSearchParams({ instrument: inst, resolution })}`, { signal: abort.signal })
      .then(data => {
        if (abort.signal.aborted) return;
        const floor = utcDate(data.earliestStart * 1000);
        setStart(prev => prev && prev < floor ? floor : prev);
        setCoverage(data);
      }).catch(e => { if (!abort.signal.aborted) setCoverageError(e instanceof Error ? e.message : "Could not load listing time."); });
    return () => abort.abort();
  }, [inst, resolution, coverageAttempt]);
  useEffect(() => () => ctl.current?.abort(), []);

  const run = async () => {
    if (ctl.current) return;
    const abort = new AbortController();
    ctl.current = abort;
    setBusy(true);
    setError(""); setRes(null);
    try {
      const r = await api<HistoricalBacktest & { ok: boolean; message?: string }>("/api/backtest", { method: "POST",
        signal: abort.signal, body: JSON.stringify({ instrument: inst, strategyId, resolution,
          start: Date.parse(start) / 1000, end: Date.parse(end) / 1000, feeBps: Number(feeBps), slippageBps: Number(slippageBps), spreadBps: Number(spreadBps) }) });
      if (!r.ok) throw new Error(r.message || "Backtest failed.");
      setRes(r);
    } catch (e) { setError(abort.signal.aborted ? "Run canceled." : e instanceof Error ? e.message : "Desk unreachable."); }
    finally { ctl.current = null; setBusy(false); }
  };

  return (
    <div className="space-y-4 p-4">
      <p className="text-sm">Replay verified public Delta India candles. A Lab run never selects a deployed strategy or places an order.</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <label className="field"><span className="label">Instrument</span>
          <select required disabled={busy} value={inst} onChange={(e) => setInstrument(e.target.value)}>{instruments.map((i) => <option key={i}>{i}</option>)}</select>
        </label>
        <label className="field"><span className="label">Strategy candidate</span>
          <select required disabled={busy} value={strategyId} onChange={e => setStrategyId(e.target.value)}>
            <option value="">Select a candidate</option>
            {catalog.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="field"><span className="label">Candle interval</span>
          <select disabled={busy} value={resolution} onChange={e => setResolution(e.target.value)}>
            {["5m", "15m", "1h", "4h", "1d"].map(v => <option key={v}>{v}</option>)}
          </select>
        </label>
        <label className="field"><span className="label">From (UTC)</span><input type="date" disabled={busy} required min={min} max={end || today} value={start} onChange={e => setStart(e.target.value)} /></label>
        <label className="field"><span className="label">Until (UTC, exclusive)</span><input type="date" disabled={busy} required min={start || min} max={today} value={end} onChange={e => setEnd(e.target.value)} /></label>
        <label className="field"><span className="label">Fee + GST (bps / side)</span><input type="number" disabled={busy} required min="5.9" max="100" step="any" value={feeBps} onChange={e => setFeeBps(e.target.value)} /></label>
        <label className="field"><span className="label">Slippage (bps / side)</span><input type="number" disabled={busy} required min="2" max="100" step="any" value={slippageBps} onChange={e => setSlippageBps(e.target.value)} /></label>
        <label className="field"><span className="label">Bid/ask spread (bps)</span><input type="number" disabled={busy} required min="1" max="100" step="any" value={spreadBps} onChange={e => setSpreadBps(e.target.value)} /></label>
        <button type="submit" className="btn btn-primary" disabled={busy || !activeCoverage || !strategyId || start >= end}>{busy ? `Running… ${Math.round(progress * 100)}%` : "Run backtest"}</button>
        {busy && <button type="button" className="btn" onClick={() => ctl.current?.abort()}>Cancel</button>}
      </form>
      {catalogError && <p role="alert">{catalogError} <button type="button" className="btn" onClick={() => reload(k => k + 1)}>Retry</button></p>}
      {coverageError && <p role="alert">{coverageError} <button type="button" className="btn" onClick={() => retryCoverage(k => k + 1)}>Retry listing lookup</button></p>}
      {activeCoverage && <p className="text-sm">{inst} listed {utcStamp(activeCoverage.launchTime)}. Earliest eligible {resolution} candle: {utcStamp(activeCoverage.earliestStart)}. Later gaps still invalidate a run.</p>}
      {error && <p role="alert" className="text-terminal-red">{error}</p>}
      <p className="text-[11.5px] text-terminal-muted">Up to five years, subject to complete exchange coverage. Signals use closed candles; fills use the next open. One unlevered position, 1% stop, 2% target; stop first if both are hit.</p>
      <p className="text-[11.5px] text-terminal-muted">Minimum fee: 5 bps taker + 18% GST = 5.9 bps per side. Each fill also pays estimated slippage and half the assumed bid/ask spread. Raise these assumptions for higher-cost markets; OHLCV does not contain historical quotes. 1 bp = 0.01%.</p>
      {res && (
        <>
          <p><b>{res.strategyName}</b> · {res.instrument} · {res.resolution} · {utcStamp(res.start)} to {utcStamp(res.end)} (exclusive) · {res.candles.toLocaleString()} closed candles</p>
          {res.requestedStart < res.start && <p className="text-sm">Requested start {utcStamp(res.requestedStart)} was moved to the first full post-listing interval.</p>}
          <p className="text-sm">Gross P/L {usd(res.stats.gross_pnl)} − fees {usd(res.stats.fees)} ({res.feeBps} bps/side) − slippage {usd(res.stats.slippage)} ({res.slippageBps} bps/side) − spread {usd(res.stats.spread)} ({res.spreadBps} bps bid/ask) = net {usd(res.stats.net_pnl)}</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            {([
              ["Net P/L", usd(res.stats.net_pnl), pnlClass(res.stats.net_pnl)], ["Return", `${res.stats.return_pct}%`, pnlClass(res.stats.return_pct)],
              ["Trades", String(res.stats.trades), ""], ["Win rate", `${res.stats.win_rate}%`, ""], ["Profit factor", res.stats.profit_factor === null ? "—" : String(res.stats.profit_factor), ""],
              ["Max DD", `${res.stats.max_drawdown_pct}%`, "text-terminal-red"], ["Avg win / loss", `${usd(res.stats.avg_win)} / ${usd(res.stats.avg_loss)}`, ""],
              ["Expectancy", usd(res.stats.expectancy), pnlClass(res.stats.expectancy)]
            ] as const).map(([k, v, c]) => <div key={k} className="kpi"><span className="label">{k}</span><b className={`num ${c || "text-terminal-text"}`}>{v}</b></div>)}
          </div>
          <EquityCurve points={res.equity_curve} />
          <div className="grid gap-4 md:grid-cols-3 text-[12px]">
            <div>
              <p className="label mb-1">Simulated equity</p>
              <p>{usd(res.stats.starting_balance)} → {usd(res.stats.final_equity)}</p>
              {!res.stats.trades && <p>No tradable signals in this window.</p>}
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
  const [journalError, setJournalError] = useState("");
  useEffect(() => {
    let active = true;
    setJournalError("");
    void api<NonNullable<typeof data>>(`/api/journal?limit=150${outcome ? `&outcome=${outcome}` : ""}`)
      .then(result => { if (active) setData(result); })
      .catch((e: unknown) => { if (active) setJournalError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [tick, outcome]);
  const review = async () => {
    try {
      const r = await post<{ ok: boolean; text: string }>("/api/review");
      if (r.ok) setData((d) => (d ? { ...d, reviews: [{ day: "today", text: r.text }, ...d.reviews] } : d));
    } catch (e) { setJournalError(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="grid gap-4 p-4 xl:grid-cols-2">
      {journalError && <p role="alert" className="text-terminal-red">{journalError}</p>}
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
