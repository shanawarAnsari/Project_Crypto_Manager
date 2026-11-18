import { useEffect, useState } from "react";
import { api, dateTime, post, px, pnlClass, time, usd } from "../api";
import { pushToast, useDesk } from "../store";
import type { JournalRow } from "../types";

const TONE: Record<string, string> = {
  taken: "border-emerald-400/50 text-emerald-300", vetoed: "border-red-500/50 text-red-300", skipped: "border-amber-400/50 text-amber-300", error: "border-red-500/50 text-red-300"
};

export function Positions() {
  const positions = useDesk((s) => s.positions);
  const execution = useDesk((s) => s.execution);
  const dataSource = useDesk((s) => s.dataSource);
  const account = useDesk((s) => s.account);
  const displayed = dataSource === "delta" ? account?.positions ?? [] : positions;
  const digits = useDesk((s) => s.digits);
  const close = async (id: string, instrument: string, venue: string) => {
    const r = venue === "delta"
      ? await post<{ ok: boolean; message: string }>(`/api/delta/close/${instrument}`)
      : await post<{ ok: boolean; message?: string }>(`/api/paper/close/${id}`);
    if (!r.ok) pushToast({ level: "error", title: "Close failed", message: r.message ?? "" });
  };
  return (
    <section className="panel">
      <header className="panel-head">
        <h2 className="panel-title">Open positions · {dataSource === "delta" ? "Delta India account" : "Paper simulation"}</h2>
        <span className="num text-xs text-terminal-muted">{displayed.length}</span>
      </header>
      {!displayed.length ? <p className="p-6 text-center text-sm text-terminal-muted">{dataSource === "delta" && (!account?.updated_at || account.error) ? "Account positions unavailable. Check account connection status." : "No open positions."}</p> : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Instrument</th><th>Side</th><th>Contracts</th><th>Entry</th><th>SL</th><th>TP1 / TP2</th><th>{dataSource === "delta" ? "Open P/L (mark)" : "Paper P/L"}</th><th /></tr></thead>
            <tbody>
              {displayed.map((p) => {
                const dg = digits[p.instrument] ?? 2;
                const pnl = dataSource === "delta" ? p.unrealized_pnl : p.unrealized_pnl + p.realized_pnl;
                return (
                  <tr key={p.id}>
                    <td className="font-semibold">{p.instrument}{p.tp1_hit && <span className="pill ml-2 border-emerald-400/40 text-emerald-300">TP1 ✓</span>}{p.breakeven && <span className="pill ml-1 border-sky-400/40 text-sky-300">BE</span>}</td>
                    <td className={p.direction === "LONG" ? "text-terminal-green" : "text-terminal-red"}>{p.direction}</td>
                    <td className="num">{p.volume}{p.volume !== p.initial_volume && <span className="text-terminal-muted"> / {p.initial_volume}</span>}</td>
                    <td className="num">{px(p.entry_price, dg)}</td>
                    <td className="num">{p.stop_loss ? px(p.stop_loss, dg) : "—"}</td>
                    <td className="num">{p.take_profit_1 ? `${px(p.take_profit_1, dg)} / ${px(p.take_profit_2, dg)}` : p.close_reason ?? "—"}</td>
                    <td className={`num font-semibold ${pnlClass(pnl)}`}>{usd(pnl)}</td>
                    <td>{(p.venue === "paper" || execution === "delta") && <button type="button" className="btn btn-danger px-2 py-1 text-xs" onClick={() => {
                      if (window.confirm(`Close ${p.instrument} on ${p.venue === "delta" ? "your Delta account" : "paper"}?`)) void close(p.id, p.instrument, p.venue);
                    }}>Close</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function SignalFeed() {
  const tick = useDesk((s) => s.journalTick);
  const [rows, setRows] = useState<JournalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api<{ decisions: JournalRow[] }>("/api/journal?limit=30")
      .then((d) => { if (active) setRows(d.decisions ?? []); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tick]);
  return (
    <section className="panel flex h-full flex-col">
      <header className="panel-head"><h2 className="panel-title">Signal history</h2><span className="text-[11px] text-terminal-muted">desk decisions · not exchange fills</span></header>
      <ul className="max-h-[320px] min-h-[160px] flex-1 space-y-1.5 overflow-y-auto p-3 text-[12px]">
        {loading && !rows.length && <li className="py-6 text-center text-terminal-muted">Loading signal history…</li>}
        {error && <li role="alert" className="py-6 text-center text-red-300">Signal history unavailable: {error}</li>}
        {!loading && !error && !rows.length && <li className="py-6 text-center text-terminal-muted">No bot decisions recorded yet.</li>}
        {rows.map((r) => (
          <li key={r.id} className="flex items-start gap-2 rounded-md border border-white/[0.05] bg-black/20 px-3 py-2">
            <span className={`pill flex-none ${TONE[r.outcome] ?? "border-terminal-border text-terminal-muted"}`}>{r.outcome}</span>
            <div className="min-w-0">
              <div className="text-terminal-text"><b>{r.instrument}</b> · <span className="num text-terminal-muted">{dateTime(r.ts)}</span></div>
              <div className="truncate text-terminal-muted" title={r.summary}>{r.summary}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DeltaStatus() {
  const h = useDesk((s) => s.delta);
  const env = useDesk((s) => s.deltaEnv);
  const [busy, setBusy] = useState(false);
  const recheck = async () => {
    setBusy(true);
    await api("/api/delta/status").catch(() => undefined);
    setBusy(false);
  };
  const ok = Boolean(h?.connected && h.authenticated && !h.issues.length);
  return (
    <section className="panel">
      <header className="panel-head">
        <h2 className="panel-title">Delta Exchange India · {env === "testnet" ? "Demo account" : "Live account"}</h2>
        <span className={`pill ${ok ? "border-emerald-400/50 text-emerald-300" : h?.connected ? "border-amber-400/50 text-amber-300" : "border-red-500/50 text-red-300"}`}>
          {ok ? "READY" : h?.connected ? "MARKET DATA ONLY" : "OFFLINE"}
        </span>
      </header>
      <div className="space-y-2 p-4 text-[12.5px]">
        <div className="grid grid-cols-2 gap-2">
          <div><span className="label">API</span><p>{h?.connected ? `Reachable · ${h.ping_ms ?? "?"}ms` : "Unreachable"}</p></div>
          <div><span className="label">API key</span><p>{h?.authenticated ? "Authenticated" : "Not authenticated"}</p></div>
          <div><span className="label">Wallet ({h?.account?.asset ?? "USD"})</span><p className="num">{h?.account ? `${usd(h.account.balance)} · avail ${usd(h.account.available)}` : "—"}</p></div>
          <div><span className="label">Live unlock</span><p>{env === "testnet" ? "Not needed (Demo)" : h?.live_unlocked ? "UNLOCKED" : "Locked"}</p></div>
        </div>
        {h && Object.entries(h.products).length > 0 && (
          <p className="text-[11px] text-terminal-muted">
            {Object.entries(h.products).map(([s, p]) => `${s} #${p.id} · ${p.contract_value}/contract · tick ${p.tick_size} · ≤${p.max_leverage}x${p.live ? "" : " (halted)"}`).join("  |  ")}
          </p>
        )}
        {h?.issues.map((i) => (
          <div key={i.code} className="rounded-md border border-amber-400/30 bg-amber-400/[0.06] p-2">
            <p className="text-amber-200">{i.message}</p>
            <p className="text-[11.5px] text-terminal-muted">Fix: {i.fix}</p>
          </div>
        ))}
        <button type="button" className="btn" disabled={busy} onClick={() => void recheck()}>{busy ? "Checking…" : "Re-check connection"}</button>
      </div>
    </section>
  );
}

export function ExecutionLog() {
  const log = useDesk((s) => s.execLog);
  return (
    <section className="panel">
      <header className="panel-head"><h2 className="panel-title">Delta execution log</h2><span className="text-[11px] text-terminal-muted">every order step</span></header>
      <ul className="max-h-[260px] space-y-1 overflow-y-auto p-3 text-[11.5px]">
        {!log.length && <li className="py-4 text-center text-terminal-muted">No exchange activity yet.</li>}
        {log.map((r, i) => (
          <li key={`${r.ts}-${i}`} className="flex gap-2 border-b border-white/[0.04] pb-1">
            <span className="num w-[58px] flex-none text-terminal-muted">{time(r.ts)}</span>
            <span className="w-[56px] flex-none">{r.symbol}</span>
            <span className={`w-[100px] flex-none ${r.status === "error" || r.status === "refused" ? "text-red-300" : "text-sky-300"}`}>{r.kind}</span>
            <span className="min-w-0 text-terminal-text/90">{r.message}{r.order_id ? ` · #${r.order_id}` : ""}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
