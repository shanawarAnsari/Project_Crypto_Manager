import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { Glass } from "../components/Glass";
import { CountUp, EquityCurve } from "../components/Metrics";
import { post } from "../lib/api";
import { usd } from "../lib/format";
import type { BacktestResult, Instrument } from "../lib/types";

type Source = "synthetic" | "delta";
const LIMITS: Record<Source, [number, number]> = { synthetic: [10, 180], delta: [3, 60] };

function Heatmap({ rows }: { rows: BacktestResult["monthly"] }) {
  if (!rows.length) return <p className="text-sm text-slate-500">No closed trades in this window.</p>;
  const max = Math.max(...rows.map((r) => Math.abs(r.pct)), 0.5);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
      {rows.map((r, i) => {
        const k = Math.min(1, Math.abs(r.pct) / max);
        const bg = r.pct >= 0 ? `rgba(16,185,129,${0.12 + k * 0.55})` : `rgba(244,63,94,${0.12 + k * 0.55})`;
        return (
          <motion.div key={r.month} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.06 * i, type: "spring", stiffness: 300, damping: 18 }}
            className="rounded-xl border border-white/[0.06] p-2.5 text-center" style={{ background: bg }}>
            <div className="text-[10px] uppercase tracking-wider text-slate-200/80">{r.month}</div>
            <div className="num text-sm font-bold text-white">{r.pct >= 0 ? "+" : ""}{r.pct.toFixed(2)}%</div>
            <div className="num text-[10px] text-slate-200/70">{usd(r.pnl, 0)}</div>
          </motion.div>
        );
      })}
    </div>
  );
}

export function BacktestView() {
  const instruments = useStore((s) => s.instruments);
  const [instrument, setInstrument] = useState<Instrument>(useStore.getState().instrument);
  const [source, setSource] = useState<Source>("synthetic");
  const [days, setDays] = useState(45);
  const [lo, hi] = LIMITS[source];
  const pickSource = (s: Source) => { setSource(s); setDays((d) => Math.min(LIMITS[s][1], Math.max(LIMITS[s][0], d))); };
  const [seed, setSeed] = useState(42);
  const [running, setRunning] = useState(false);
  const [res, setRes] = useState<BacktestResult | null>(null);
  const [replay, setReplay] = useState(0);
  const progress = useStore((s) => s.backtestProgress);
  const beginner = useStore((s) => s.beginner);

  const run = async () => {
    setRunning(true);
    useStore.getState().set({ backtestProgress: 0 });
    try {
      const r = await post<BacktestResult & { ok: boolean }>("/api/backtest", { instrument, days, seed, source });
      setRes(r);
      setReplay(0);
    } catch {
      /* toast shown by api() */
    } finally {
      setRunning(false);
    }
  };

  // animated equity-curve replay: reveal the curve progressively
  useEffect(() => {
    if (!res) return;
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / 3200);
      setReplay(p);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [res]);

  const shown = res ? res.equity_curve.slice(0, Math.max(2, Math.floor(res.equity_curve.length * replay))) : [];
  const lastT = shown[shown.length - 1]?.time ?? 0;
  const markers = res
    ? res.trades.flatMap((t) => [{ time: t.time, type: "entry" }, ...(t.closed ? [{ time: t.closed, type: "exit", pnl: t.pnl }] : [])]).filter((m) => m.time <= lastT)
    : [];
  const st = res?.stats;

  return (
    <div className="h-full space-y-3 overflow-y-auto pb-2">
      <Glass className="p-4" title="Backtest Lab · same Hunter + Guardian rules as live" glow="violet">
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <div>
            <div className="label mb-1">Instrument</div>
            <div className="flex gap-1.5">
              {instruments.map((i) => (
                <button key={i} onClick={() => setInstrument(i)} className={`rounded-lg px-3 py-1.5 text-xs ${instrument === i ? "bg-violet-500/20 text-white shadow-violet" : "btn-ghost"}`}>{i}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="label mb-1">Candles</div>
            <div className="flex gap-1.5">
              {([["synthetic", "Synthetic (seeded)"], ["delta", "Delta India history"]] as [Source, string][]).map(([s, l]) => (
                <button key={s} onClick={() => pickSource(s)} className={`rounded-lg px-3 py-1.5 text-xs ${source === s ? "bg-violet-500/20 text-white shadow-violet" : "btn-ghost"}`}>{l}</button>
              ))}
            </div>
          </div>
          <label className="w-56">
            <div className="label mb-1">Days of history: <span className="num text-white">{days}</span></div>
            <input type="range" min={lo} max={hi} value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-full accent-violet-400" />
          </label>
          {!beginner && source === "synthetic" && (
            <label className="w-28">
              <div className="label mb-1">Seed</div>
              <input className="input py-1.5" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
            </label>
          )}
          <button onClick={() => void run()} disabled={running || !instrument} data-cursor="Run" className="btn-primary">{running ? "Running…" : "Run backtest"}</button>
          {running && (
            <div className="h-2 w-56 overflow-hidden rounded-full bg-white/10">
              <motion.div className="h-full bg-gradient-to-r from-cyan-400 to-violet-500" animate={{ width: `${Math.max(4, progress * 100)}%` }} />
            </div>
          )}
        </div>
        <p className="mt-3 text-[11.5px] text-amber-200/80">Backtests on synthetic or historical data do not guarantee future results. The Analyst uses rule-based scoring here for reproducibility. Delta history is fetched from Delta Exchange India (max 60 days).</p>
      </Glass>

      {!res && !running && <Glass className="p-10 text-center text-sm text-slate-400">Pick an instrument and run a backtest to see the equity replay, trade markers and a monthly returns heatmap.</Glass>}
      {running && !res && <div className="grid grid-cols-4 gap-3">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-24 rounded-2xl" />)}</div>}

      {res && st && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {[
              { k: "Net P/L", v: st.net_pnl, f: (x: number) => `${x >= 0 ? "+" : ""}${usd(x, 0)}`, c: st.net_pnl >= 0 ? "text-profit" : "text-loss" },
              { k: "Return", v: st.return_pct, f: (x: number) => `${x.toFixed(2)}%`, c: st.return_pct >= 0 ? "text-profit" : "text-loss" },
              { k: "Win rate", v: st.win_rate, f: (x: number) => `${x.toFixed(1)}%`, c: "text-white" },
              { k: "Profit factor", v: st.profit_factor, f: (x: number) => x.toFixed(2), c: "text-white" },
              { k: "Max drawdown", v: st.max_drawdown_pct, f: (x: number) => `${x.toFixed(2)}%`, c: "text-amber-200" },
              { k: "Trades", v: st.trades, f: (x: number) => String(Math.round(x)), c: "text-white" },
            ].map((x, i) => (
              <motion.div key={x.k} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.07 }}>
                <Glass className="p-3.5" tilt>
                  <div className="label">{x.k}</div>
                  <div className={`mt-1 font-display text-2xl font-bold ${x.c}`}><CountUp value={x.v} format={x.f} /></div>
                </Glass>
              </motion.div>
            ))}
          </div>
          <Glass className="p-4" title={`Equity replay · ${res.instrument} · ${res.source === "delta" ? "Delta India history" : "synthetic"} · ${res.days} days · ${res.candles.toLocaleString()} candles`}
            right={<button onClick={() => setRes({ ...res })} className="btn-ghost px-3 py-1 text-xs">↺ Replay</button>}>
            <div className="mt-3"><EquityCurve points={shown} markers={markers} color="auto" height={220} /></div>
            <div className="mt-2 flex gap-4 text-[11px] text-slate-400">
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-cyan-neon" />entry</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-profit" />winning exit</span>
              <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-loss" />losing exit</span>
              {!beginner && <span className="num ml-auto">expectancy {usd(st.expectancy)} · avg win {usd(st.avg_win)} · avg loss {usd(st.avg_loss)} · ran in {res.elapsed_s}s</span>}
            </div>
          </Glass>
          <div className="grid gap-3 xl:grid-cols-[2fr_1fr]">
            <Glass className="p-4" title="Monthly returns"><div className="mt-3"><Heatmap rows={res.monthly} /></div></Glass>
            <Glass className="p-4" title="AEGIS decisions">
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-slate-400">Taken</span><span className="num text-emerald-300">{res.decisions.taken}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Vetoed</span><span className="num text-rose-300">{res.decisions.vetoed}</span></div>
                {Object.entries(res.veto_reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
                  const max = Math.max(...Object.values(res.veto_reasons));
                  return (
                    <div key={k}>
                      <div className="flex justify-between text-[11.5px]"><span className="text-slate-300">{k}</span><span className="num text-slate-400">{v}</span></div>
                      <div className="mt-1 h-1.5 rounded-full bg-white/5">
                        <motion.div className="h-full rounded-full bg-loss/70" initial={{ width: 0 }} animate={{ width: `${(v / max) * 100}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Glass>
          </div>
        </>
      )}
    </div>
  );
}
