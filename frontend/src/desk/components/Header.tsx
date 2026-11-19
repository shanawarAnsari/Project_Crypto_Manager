import { useEffect, useState } from "react";
import { post, usd } from "../api";
import { pushToast, useDesk } from "../store";

const MODE_TONE: Record<string, string> = {
  "DELTA DEMO · OBSERVE": "border-sky-500/50 text-sky-300",
  "DELTA DEMO · ARMED": "border-emerald-400/60 text-emerald-300"
};

export function TopBar() {
  const mode = useDesk((s) => s.mode);
  const session = useDesk((s) => s.session);
  const connected = useDesk((s) => s.connected);
  const analystMode = useDesk((s) => s.analystMode);
  const model = useDesk((s) => s.model);
  const paused = useDesk((s) => s.paused);
  const kill = useDesk((s) => s.kpis?.kill_switch ?? false);
  const reportFailure = (err: unknown) => pushToast({ level: "error", title: "Desk command failed", message: String(err) });
  const toggleKill = async () => {
    if (kill) {
      await post("/api/kill", { engaged: false, close_all: false });
      return;
    }
    if (window.confirm("Block new demo entries? Existing positions and protective brackets stay on Delta. Manage them directly on the exchange.")) {
      await post("/api/kill", { engaged: true, close_all: false });
    }
  };

  return (
    <header className="topbar">
      <div className="flex items-center gap-3">
        <div className="brand-mark">◆</div>
        <div>
          <h1 className="text-sm font-bold tracking-wide text-terminal-text">Crypto Manager</h1>
          <p className="text-[10px] uppercase tracking-[0.18em] text-terminal-muted">Strategy desk · Delta Exchange India</p>
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
        <button type="button" disabled={!connected} className="btn" onClick={() => void post("/api/pause", { paused: !paused }).catch(reportFailure)}>{paused ? "▶ Resume scan" : "❚❚ Pause scan"}</button>
        <button type="button" disabled={!connected} className={`btn ${kill ? "btn-danger-on" : "btn-danger"}`} onClick={() => void toggleKill().catch(reportFailure)}>{kill ? "Release kill switch" : "KILL SWITCH"}</button>
      </div>
    </header>
  );
}

export function Banner() {
  const banner = useDesk((s) => s.banner);
  const kill = useDesk((s) => s.kpis?.kill_switch ?? false);
  return (
    <>
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
  const account = useDesk((s) => s.account);
  const connected = useDesk((s) => s.connected);
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, []);
    const stale = !connected || !account?.updated_at || now - account.updated_at > 15 || Boolean(account.error);
    return (
      <section aria-label="Exchange account" className="space-y-2">
        <p className="text-xs text-terminal-muted">
          Delta India Demo account (not real money) · {stale ? "ACCOUNT DATA UNAVAILABLE OR STALE" : "Account synced"}
          {account?.updated_at ? ` · updated ${Math.max(0, Math.floor(now - account.updated_at))}s ago` : ""}
        </p>
        {account?.error && <p role="alert" className="text-xs text-terminal-red">{account.error}</p>}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Kpi label={`Account equity (${account?.wallet?.asset ?? "USD"})`} value={usd(account?.equity)} sub={stale ? "Last received; do not rely on stale data" : "Balance + open unrealized P/L"} />
          <Kpi label="Wallet balance" value={usd(account?.wallet?.balance)} />
          <Kpi label="Available margin" value={usd(account?.wallet?.available)} />
          <Kpi
            label="Account P/L (open)"
            value={usd(account?.equity != null && account.wallet ? account.equity - account.wallet.balance : null)}
            sub="Unrealized P/L across exchange positions"
            tone={account?.equity != null && account.wallet
              ? account.equity > account.wallet.balance ? "text-terminal-green" : account.equity < account.wallet.balance ? "text-terminal-red" : undefined
              : undefined}
          />
          <Kpi label="Open account positions" value={account?.updated_at ? String(account.positions.length) : "—"} sub="All symbols, including manual trades" />
        </div>
      </section>
    );
}
