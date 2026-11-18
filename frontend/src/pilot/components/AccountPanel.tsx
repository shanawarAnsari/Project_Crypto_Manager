import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { Glass } from "./Glass";
import { CountUp, DrawdownGauge, EquityCurve } from "./Metrics";
import { KillSwitch } from "./KillSwitch";
import { usd } from "../lib/format";

/**
 * AEGIS shield: a layered 3D (CSS perspective) hex shield that glows emerald when all
 * checks pass and cracks rose on a veto or drawdown breach.
 */
function Shield({ state }: { state: "ok" | "veto" | "breach" | "killed" | "paused" | "unavailable" }) {
  const reduce = useReducedMotion();
  const bad = state === "veto" || state === "breach" || state === "killed";
  const color = state === "ok" ? "#10b981" : state === "paused" || state === "unavailable" ? "#f59e0b" : "#f43f5e";
  return (
    <motion.div className="relative h-[86px] w-[76px] flex-none" style={{ perspective: 500 }}
      animate={state === "veto" && !reduce ? { x: [0, -5, 5, -4, 4, 0] } : { x: 0 }} transition={{ duration: 0.5 }}>
      <motion.div className="absolute inset-0" style={{ transformStyle: "preserve-3d" }}
        animate={reduce ? {} : { rotateY: [-18, 18, -18] }} transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}>
        {[0, 1, 2].map((layer) => (
          <svg key={layer} viewBox="0 0 76 86" className="absolute inset-0" style={{ transform: `translateZ(${layer * 7}px)`, opacity: 1 - layer * 0.3 }}>
            <path d="M38 3 L71 15 L68 50 Q60 72 38 83 Q16 72 8 50 L5 15 Z" fill={layer === 0 ? `${color}22` : "none"}
              stroke={color} strokeWidth={layer === 0 ? 2.4 : 1} style={{ filter: `drop-shadow(0 0 ${8 - layer * 2}px ${color})` }} />
          </svg>
        ))}
        <svg viewBox="0 0 76 86" className="absolute inset-0" style={{ transform: "translateZ(22px)" }}>
          {bad ? (
            <motion.path d="M38 12 L32 30 L42 38 L30 54 L40 62 L35 76 M42 38 L54 44 M32 30 L20 34"
              fill="none" stroke="#fecdd3" strokeWidth="1.6" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.5 }} />
          ) : state === "ok" ? (
            <motion.path d="M25 44 L34 53 L52 33" fill="none" stroke="#a7f3d0" strokeWidth="3.5" strokeLinecap="round"
              initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6 }} />
          ) : (
            <text x="38" y="58" textAnchor="middle" fill="#fde68a" fontSize="34" fontWeight="600">!</text>
          )}
        </svg>
      </motion.div>
    </motion.div>
  );
}

function DeltaAccountCard() {
  const account = useStore((s) => s.account);
  const env = useStore((s) => s.deltaEnv);
  const delta = useStore((s) => s.delta);
  const wallet = account?.wallet;
  const tag = env === "testnet" ? "DEMO" : "LIVE";
  if (!wallet) {
    return (
      <Glass className="p-4" title={`Delta India · ${tag} account`}>
        <p className="mt-2 text-[12.5px] text-slate-400">
          {account?.error ?? delta?.issues?.[0]?.message ?? "Waiting for the first account sync…"}
        </p>
      </Glass>
    );
  }
  const upnl = account.positions.reduce((s, p) => s + p.unrealized_pnl, 0);
  return (
    <Glass glow={env === "testnet" ? "cyan" : "loss"} className="p-4" title={`Delta India · ${tag} account`} right={
      <span className={`chip font-mono text-[10px] ${env === "testnet" ? "border-profit/50 text-emerald-200" : "border-loss text-rose-200"}`}>{tag}</span>}>
      <div className="mt-2 font-display text-[26px] font-bold leading-none text-white">
        <CountUp value={account.equity ?? wallet.balance} format={(v) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${wallet.asset}`} />
      </div>
      <div className="mt-1 text-[11px] text-slate-400">Equity · real exchange data{account.updated_at ? ` · synced ${new Date(account.updated_at * 1000).toLocaleTimeString("en-GB")}` : ""}</div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {[
          { k: "Wallet", v: wallet.balance.toFixed(2) },
          { k: "Available", v: wallet.available.toFixed(2) },
          { k: "Positions", v: `${account.positions.length}${account.positions.length ? ` · ${upnl >= 0 ? "+" : ""}${upnl.toFixed(2)}` : ""}` }
        ].map((x) => (
          <div key={x.k} className="rounded-xl border border-white/[0.06] bg-black/20 px-2.5 py-2">
            <div className="text-[10px] uppercase tracking-wider text-slate-500">{x.k}</div>
            <div className="num text-sm font-semibold text-slate-100">{x.v}</div>
          </div>
        ))}
      </div>
    </Glass>
  );
}

export function AccountPanel() {
  const kpis = useStore((s) => s.kpis);
  const equity = useStore((s) => s.equity);
  const vetoAt = useStore((s) => s.agents.Guardian.vetoAt);
  const beginner = useStore((s) => s.beginner);
  const execution = useStore((s) => s.execution);
  const env = useStore((s) => s.deltaEnv);
  const account = useStore((s) => s.account);
  const delta = useStore((s) => s.delta);
  const paused = useStore((s) => s.paused);
  const wsConnected = useStore((s) => s.wsConnected);
  const [vetoFlash, setVetoFlash] = useState(false);
  useEffect(() => {
    if (!vetoAt) return;
    setVetoFlash(true);
    const t = window.setTimeout(() => setVetoFlash(false), 2600);
    return () => window.clearTimeout(t);
  }, [vetoAt]);

  if (!kpis) {
    return (
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => <div key={i} className="skeleton h-28 rounded-2xl" />)}
      </div>
    );
  }
  const onDelta = execution === "delta";
  const accountFresh = !onDelta || Boolean(
    wsConnected && delta?.connected && delta.authenticated && account?.wallet && !account.error && account.updated_at &&
    Date.now() / 1000 - account.updated_at <= 15
  );
  const breach = accountFresh && kpis.drawdown_pct >= kpis.dd_limit_pct;
  const shieldState = kpis.kill_switch ? "killed" : !accountFresh ? "unavailable" : breach ? "breach" : paused ? "paused" : vetoFlash ? "veto" : "ok";
  const aegisStatus = {
    ok: "armed", veto: "veto", breach: "drawdown limit", killed: "locked", paused: "paused", unavailable: "data unavailable"
  }[shieldState];
  const pnlColor = kpis.today_pnl >= 0 ? "text-profit" : "text-loss";

  return (
    <div className="flex flex-col gap-3">
      <DeltaAccountCard />
      <Glass glow={shieldState === "ok" ? "profit" : "loss"} className="p-4" tour="kpis">
        <div className="flex items-start gap-4">
          <Shield state={shieldState} />
          <div className="min-w-0 flex-1">
            <div className="label">{onDelta ? `Desk · Delta ${env === "testnet" ? "DEMO" : "LIVE"} orders` : "Paper simulation (not your exchange balance)"} · AEGIS {aegisStatus}</div>
            <div className="mt-1 font-display text-[28px] font-bold leading-none text-white">
              {onDelta && !accountFresh ? "—" : <CountUp value={kpis.equity} format={(v) => usd(v)} />}
            </div>
            <div className={`mt-1.5 text-sm font-semibold ${pnlColor}`}>
              {onDelta && !accountFresh
                ? "Exchange account data unavailable"
                : <><CountUp value={kpis.today_pnl} format={(v) => `${v >= 0 ? "+" : ""}${usd(v)}`} /> today
                  <span className="ml-1.5 text-xs opacity-80">({kpis.today_pnl_pct >= 0 ? "+" : ""}{kpis.today_pnl_pct.toFixed(2)}%)</span></>}
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {[
            { k: "Win rate", v: kpis.trades ? `${kpis.win_rate.toFixed(1)}%` : "—", sub: `${kpis.trades} closed trades` },
            { k: "Open risk", v: !accountFresh ? "—" : kpis.open_risk === null ? "Unknown" : usd(kpis.open_risk, 0),
              sub: !accountFresh ? "Account unavailable" : kpis.open_risk_pct === null ? "Unmanaged exposure" : `${kpis.open_risk_pct.toFixed(2)}%` },
            { k: "Balance", v: onDelta && !accountFresh ? "—" : usd(kpis.balance, 0), sub: onDelta ? "Delta" : "paper" }
          ].map((x) => (
            <div key={x.k} className="rounded-xl border border-white/[0.06] bg-black/20 px-2.5 py-2">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">{x.k}</div>
              <div className="num text-sm font-semibold text-slate-100">{x.v}</div>
              {!beginner && <div className="text-[10px] text-slate-500">{x.sub}</div>}
            </div>
          ))}
        </div>
      </Glass>

      <Glass className="px-4 pb-3 pt-3" title="Equity curve">
        <div className="mt-2"><EquityCurve points={equity.slice(-400)} color="auto" height={78} /></div>
      </Glass>

      <div className="grid grid-cols-[128px_1fr] gap-3">
        <Glass className="p-3" title="Daily drawdown">
          <div className="mt-2">{accountFresh ? <DrawdownGauge value={kpis.drawdown_pct} limit={kpis.dd_limit_pct} /> :
            <p className="py-5 text-center text-xs text-amber-200">Account data unavailable</p>}</div>
        </Glass>
        <Glass glow="loss" className="p-3"><KillSwitch /></Glass>
      </div>
    </div>
  );
}
