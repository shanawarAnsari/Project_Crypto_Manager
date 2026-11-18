import { useEffect, useState } from "react";
import { post, usd } from "../api";
import { pushToast, useDesk } from "../store";

const MODE_TONE: Record<string, string> = {
  DEMO: "border-sky-500/50 text-sky-300", PAPER: "border-amber-400/50 text-amber-300",
  "DELTA DEMO": "border-emerald-400/60 text-emerald-300", "DELTA LIVE": "border-red-500/70 bg-red-500/15 text-red-300"
};

export function TopBar() {
  const mode = useDesk((s) => s.mode);
  const session = useDesk((s) => s.session);
  const connected = useDesk((s) => s.connected);
  const analystMode = useDesk((s) => s.analystMode);
  const model = useDesk((s) => s.model);
  const dataSource = useDesk((s) => s.dataSource);
  const instrument = useDesk((s) => s.instrument);
  const paused = useDesk((s) => s.paused);
  const kill = useDesk((s) => s.kpis?.kill_switch ?? false);
  const [busy, setBusy] = useState(false);

  const scenario = async () => {
    setBusy(true);
    const r = await post<{ ok: boolean; message?: string }>("/api/demo/scenario", { instrument }).catch(() => ({ ok: false, message: "Desk unreachable" }));
    if (!r.ok) pushToast({ level: "warning", title: "Scenario not started", message: r.message ?? "" });
    setBusy(false);
  };
  const toggleKill = async () => {
    if (kill) {
      await post("/api/kill", { engaged: false, close_all: false });
      return;
    }
    if (window.confirm("Engage the kill switch? New orders are blocked and every open position is closed.")) {
      await post("/api/kill", { engaged: true, close_all: true });
    }
  };

  return (
    <header className="topbar">
      <div className="flex items-center gap-3">
        <div className="brand-mark">◆</div>
        <div>
          <h1 className="text-sm font-bold tracking-wide text-terminal-text">Crypto Manager</h1>
          <p className="text-[10px] uppercase tracking-[0.18em] text-terminal-muted">Liquidity Sweep Desk · Delta Exchange India</p>
        </div>
        <span className={`pill ${MODE_TONE[mode] ?? "border-terminal-border text-terminal-muted"}`}>{mode}</span>
      </div>
      <div className="hidden items-center gap-5 text-xs md:flex">
        {session && (
          <div className="flex flex-col">
            <span className="label">Market · 24/7</span>
            <b className="text-terminal-text">{session.session === "OFF_HOURS" ? "OVERNIGHT" : session.session.replace("_", " ")}</b>
          </div>
        )}
        {session && (
          <div className="flex flex-col">
            <span className="label">UTC · IST</span>
            <b className="num text-terminal-text">{session.utc} · {session.ist}</b>
          </div>
        )}
        <div className="flex flex-col">
          <span className="label">Analyst</span>
          <b className="text-terminal-text" title={model}>{analystMode === "llm" ? "LLM" : "Rule-based"}</b>
        </div>
        <span className={`flex items-center gap-1.5 ${connected ? "text-terminal-green" : "text-terminal-red"}`}>
          <i className={`h-2 w-2 rounded-full ${connected ? "bg-terminal-green" : "bg-terminal-red"}`} />{connected ? "Desk connected" : "Desk offline"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn" onClick={() => void post("/api/pause", { paused: !paused })}>{paused ? "▶ Resume" : "❚❚ Pause"}</button>
        {dataSource === "demo" && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void scenario()}>Run Demo Scenario</button>}
        <button type="button" className={`btn ${kill ? "btn-danger-on" : "btn-danger"}`} onClick={() => void toggleKill()}>{kill ? "Release kill switch" : "KILL SWITCH"}</button>
      </div>
    </header>
  );
}

export function Banner() {
  const banner = useDesk((s) => s.banner);
  const kill = useDesk((s) => s.kpis?.kill_switch ?? false);
  const mode = useDesk((s) => s.mode);
  return (
    <>
      {mode === "DELTA LIVE" && <div className="banner border-red-500/50 bg-red-500/10 text-red-200">LIVE: orders go to your real-money Delta Exchange India account. Risk of loss is real.</div>}
      {kill && <div className="banner border-red-500/50 bg-red-500/10 text-red-200">Kill switch engaged: AEGIS vetoes every new signal.</div>}
      {banner && <div className="banner border-amber-400/40 bg-amber-400/10 text-amber-200">{banner}</div>}
    </>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="kpi">
      <span className="label">{label}</span>
      <b className={`num text-lg ${tone ?? "text-terminal-text"}`}>{value}</b>
      {sub && <span className="text-[11px] text-terminal-muted">{sub}</span>}
    </div>
  );
}

export function KpiStrip() {
  const k = useDesk((s) => s.kpis);
  const equity = useDesk((s) => s.equity);
  const dataSource = useDesk((s) => s.dataSource);
  const account = useDesk((s) => s.account);
  const env = useDesk((s) => s.deltaEnv);
  const connected = useDesk((s) => s.connected);
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (dataSource === "delta") {
    const stale = !connected || !account?.updated_at || now - account.updated_at > 15 || Boolean(account.error);
    return (
      <section aria-label="Exchange account" className="space-y-2">
        <p className="text-xs text-terminal-muted">
          Delta India {env === "testnet" ? "DEMO account (not real money)" : "LIVE account"} · {stale ? "ACCOUNT DATA UNAVAILABLE OR STALE" : "Account synced"}
          {account?.updated_at ? ` · updated ${Math.max(0, Math.floor(now - account.updated_at))}s ago` : ""}
          {" · Account values are independent of paper execution."}
        </p>
        {account?.error && <p role="alert" className="text-xs text-terminal-red">{account.error}</p>}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label={`Account equity (${account?.wallet?.asset ?? "USD"})`} value={usd(account?.equity)} sub={stale ? "Last received; do not rely on stale data" : "Balance + open unrealized P/L"} />
          <Kpi label="Wallet balance" value={usd(account?.wallet?.balance)} />
          <Kpi label="Available margin" value={usd(account?.wallet?.available)} />
          <Kpi label="Open account positions" value={account?.updated_at ? String(account.positions.length) : "—"} sub="All symbols, including manual trades" />
        </div>
      </section>
    );
  }
  if (!k) return <div className="grid grid-cols-2 gap-3 md:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <div key={i} className="kpi h-[74px] animate-pulse" />)}</div>;
  const pts = equity.slice(-120);
  const min = Math.min(...pts.map((p) => p.equity));
  const max = Math.max(...pts.map((p) => p.equity));
  const path = pts.map((p, i) => `${(i / Math.max(1, pts.length - 1)) * 100},${max === min ? 15 : 28 - ((p.equity - min) / (max - min)) * 26}`).join(" ");
  const ddUse = k.dd_limit_pct ? Math.min(100, (k.drawdown_pct / k.dd_limit_pct) * 100) : 0;
  return (
    <div aria-label="Synthetic paper simulation" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <div className="kpi">
        <span className="label">Simulated equity (not your account)</span>
        <b className="num text-lg text-terminal-text">{usd(k.equity)}</b>
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-5 w-full"><polyline points={path} fill="none" stroke="#35d39a" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>
      </div>
      <Kpi label="Today P/L" value={usd(k.today_pnl)} sub={`${k.today_pnl_pct >= 0 ? "+" : ""}${k.today_pnl_pct.toFixed(2)}%`} tone={k.today_pnl >= 0 ? "text-terminal-green" : "text-terminal-red"} />
      <Kpi label="Win rate" value={k.trades ? `${k.win_rate.toFixed(1)}%` : "—"} sub={`${k.trades} closed trades`} />
      <Kpi label="Open risk" value={k.open_risk === null ? "Unknown" : usd(k.open_risk)}
        sub={k.open_risk_pct === null ? "Cannot verify all positions" : `${k.open_risk_pct.toFixed(2)}% of equity`} />
      <Kpi label="Balance" value={usd(k.balance)} />
      <div className="kpi">
        <span className="label">Daily drawdown</span>
        <b className={`num text-lg ${ddUse >= 75 ? "text-terminal-red" : "text-terminal-text"}`}>{k.drawdown_pct.toFixed(2)}%</b>
        <div className="mt-1 h-1.5 w-full rounded bg-terminal-border"><div className={`h-1.5 rounded ${ddUse >= 75 ? "bg-terminal-red" : "bg-terminal-amber"}`} style={{ width: `${ddUse}%` }} /></div>
        <span className="text-[11px] text-terminal-muted">kill at {k.dd_limit_pct}%</span>
      </div>
    </div>
  );
}
