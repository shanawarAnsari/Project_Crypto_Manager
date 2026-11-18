import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useStore } from "../store/useStore";
import { Glass } from "../components/Glass";
import { DeltaStatusCard } from "../components/DeltaPanels";
import { post, put } from "../lib/api";
import type { Params, Rules } from "../lib/types";

type NumKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

function Tip({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-white/20 text-[9px] text-slate-400" data-cursor="Info">
      ?
      <span className="pointer-events-none absolute bottom-5 left-1/2 z-20 w-56 -translate-x-1/2 rounded-lg border border-white/10 bg-space-800 p-2 text-[11px] normal-case leading-snug tracking-normal text-slate-200 opacity-0 shadow-xl transition-opacity group-hover:opacity-100">
        {text}
      </span>
    </span>
  );
}

const RULE_FIELDS: { k: NumKey<Rules>; label: string; tip: string; step: number; basic?: boolean }[] = [
  { k: "risk_per_trade_pct", label: "Risk per trade %", tip: "Share of equity risked between entry and stop; contract size is computed from this. Max 2%.", step: 0.1, basic: true },
  { k: "max_risk_per_trade_pct", label: "Max risk per trade %", tip: "Hard ceiling. If one contract would risk more, the trade is vetoed.", step: 0.1 },
  { k: "daily_drawdown_kill_pct", label: "Daily drawdown kill %", tip: "When today's equity drop reaches this, every new signal is vetoed until tomorrow (UTC).", step: 0.5, basic: true },
  { k: "max_open_trades", label: "Max open trades", tip: "Maximum simultaneous positions (one per instrument).", step: 1, basic: true },
  { k: "min_rr", label: "Minimum RR (1:x)", tip: "Reward to TP1 divided by risk to SL must be at least this.", step: 0.1, basic: true },
  { k: "min_confidence", label: "Minimum confidence", tip: "Analyst confidence (1-10) required to trade.", step: 1, basic: true },
  { k: "spread_limit_pct", label: "Spread limit %", tip: "Veto when the bid/ask spread exceeds this percentage of price.", step: 0.01 },
  { k: "leverage", label: "Leverage (x)", tip: "Leverage set on Delta before each order. Risk is controlled by stop distance; leverage only sets margin.", step: 1, basic: true },
  { k: "cooldown_minutes", label: "Cooldown (minutes)", tip: "After a trade on a level, ignore that same level for this long (duplicate-signal protection).", step: 5 }
];

const PARAM_FIELDS: { k: keyof Params; label: string; tip: string; min: number; max: number; step: number; basic?: boolean }[] = [
  { k: "min_depth_pct", label: "Min sweep depth %", tip: "How far beyond the level the wick must reach to count as a stop hunt.", min: 0.01, max: 1, step: 0.01, basic: true },
  { k: "max_depth_pct", label: "Max sweep depth %", tip: "Deeper than this is treated as a genuine breakout, not a sweep.", min: 0.05, max: 3, step: 0.01, basic: true },
  { k: "displacement_mult", label: "Displacement × avg body", tip: "The confirmation candle's body must be at least this many times the average body.", min: 1, max: 4, step: 0.1, basic: true },
  { k: "confirm_candles", label: "Close back inside within (candles)", tip: "The displacement close must happen within this many candles of the sweep.", min: 1, max: 6, step: 1 },
  { k: "sl_buffer_pct", label: "SL buffer %", tip: "Extra distance beyond the wick extreme for the stop.", min: 0, max: 0.5, step: 0.01 },
  { k: "tp1_rr", label: "TP1 RR", tip: "TP1 distance as a multiple of risk; must be at least the Guardian's minimum RR.", min: 1, max: 5, step: 0.1, basic: true },
  { k: "tp2_min_rr", label: "TP2 minimum RR", tip: "TP2 targets the next liquidity pool at least this many R away.", min: 1, max: 8, step: 0.1 },
  { k: "body_lookback", label: "Body lookback (candles)", tip: "Candles used for the average body and volume.", min: 5, max: 60, step: 1 },
  { k: "volume_spike_mult", label: "Volume spike ×", tip: "Volume above this multiple of average counts as a spike (confidence bonus).", min: 1, max: 4, step: 0.1 },
  { k: "eq_tolerance_pct", label: "Equal highs/lows tolerance %", tip: "Swing points within this distance form an equal-highs/lows pool.", min: 0.01, max: 0.5, step: 0.01 }
];

const SESSIONS = ["ASIAN", "LONDON", "NEW_YORK", "OFF_HOURS"];

function Btn({ on, label, onClick, disabled, title }: { on: boolean; label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button disabled={disabled} title={title} onClick={onClick}
      className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${on ? "bg-cyan-500/20 text-white shadow-glow" : "btn-ghost"}`}>{label}</button>
  );
}

function ModeSwitch() {
  const dataSource = useStore((s) => s.dataSource);
  const execution = useStore((s) => s.execution);
  const delta = useStore((s) => s.delta);
  const env = useStore((s) => s.deltaEnv);
  const [busy, setBusy] = useState(false);
  const setMode = async (body: Record<string, string>) => {
    setBusy(true);
    const r = await post<{ ok: boolean; message?: string }>("/api/mode", body).catch(() => ({ ok: false, message: "Desk unreachable" }));
    useStore.getState().pushToast({ level: r.ok ? "success" : "warning", title: r.ok ? "Mode updated" : "Mode unchanged", message: r.message ?? "The desk switched modes." });
    setBusy(false);
  };
  return (
    <Glass className="p-4" title="Mode">
      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-24 text-xs text-slate-400">Market data</span>
          <Btn on={dataSource === "demo"} label="Demo (synthetic)" onClick={() => void setMode({ data_source: "demo" })} disabled={busy || execution === "delta"}
            title={execution === "delta" ? "Switch execution to Paper first" : ""} />
          <Btn on={dataSource === "delta"} label="Delta India live feed" onClick={() => void setMode({ data_source: "delta" })} disabled={busy || !delta?.connected}
            title={!delta?.connected ? "Delta India is unreachable right now" : ""} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-24 text-xs text-slate-400">Execution</span>
          <Btn on={execution === "paper"} label="Paper engine" onClick={() => void setMode({ execution: "paper" })} disabled={busy} />
          <Btn on={execution === "delta"} label={`Delta orders (${env === "testnet" ? "Demo" : "LIVE"})`} onClick={() => void setMode({ execution: "delta" })}
            disabled={busy || !delta?.authenticated} title={!delta?.authenticated ? "Configure and verify your Delta API key first" : ""} />
        </div>
        <p className="text-[11.5px] text-slate-400">
          Paper is the default. With <code>DELTA_ENV=testnet</code> orders go to your <b className="text-emerald-300">Delta India Demo account</b>; production orders also require the live unlock.
        </p>
      </div>
    </Glass>
  );
}

function DeltaControls() {
  const instruments = useStore((s) => s.instruments);
  const env = useStore((s) => s.deltaEnv);
  const delta = useStore((s) => s.delta);
  const phrase = useStore((s) => s.confirmPhrase);
  const [typed, setTyped] = useState("");
  const [inst, setInst] = useState("");
  const [busy, setBusy] = useState(false);
  const chosen = inst || instruments[0] || "";
  const testOrder = async () => {
    setBusy(true);
    await post("/api/delta/test-order", { instrument: chosen }).catch(() => undefined);
    setBusy(false);
  };
  const live = async (enable: boolean) => {
    const r = await post<{ ok: boolean; message: string }>("/api/delta/live", { enable, phrase: typed }).catch(() => ({ ok: false, message: "Desk unreachable" }));
    useStore.getState().pushToast({ level: r.ok ? (enable ? "error" : "success") : "warning", title: "Live trading", message: r.message });
    setTyped("");
  };
  return (
    <Glass className="p-4" title="Delta India orders & live trading">
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select className="input w-auto py-1.5" value={chosen} onChange={(e) => setInst(e.target.value)}>
          {instruments.map((i) => <option key={i} value={i}>{i}</option>)}
        </select>
        <button className="btn-ghost px-3 py-1.5 text-xs" disabled={busy || !delta?.authenticated || env !== "testnet"} onClick={() => void testOrder()}
          title={env !== "testnet" ? "Test orders run on the Demo account only" : ""}>{busy ? "Sending…" : "Send test order (1 contract, then close)"}</button>
      </div>
      <div className="mt-4 rounded-xl border border-loss/30 bg-loss/[0.06] p-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-display text-sm font-semibold text-rose-200">Live (real-money) trading</div>
            <div className="text-[11px] text-slate-400">
              {env !== "production" ? "Not applicable: DELTA_ENV=testnet routes every order to your Demo account." : "Orders are refused until you type the confirmation phrase."}
            </div>
          </div>
          <span className={`chip ${env === "production" && delta?.live_unlocked ? "border-loss bg-loss/70 text-white" : "border-profit/50 text-emerald-300"}`}>
            {env !== "production" ? "DEMO ACCOUNT" : delta?.live_unlocked ? "LIVE UNLOCKED" : "LIVE LOCKED"}
          </span>
        </div>
        {env === "production" && (delta?.live_unlocked
          ? <button className="btn-ghost mt-2 px-3 py-1.5 text-xs" onClick={() => void live(false)}>Lock live trading</button>
          : (
            <div className="mt-2 flex gap-2">
              <input className="input py-1.5" placeholder={`Type: ${phrase}`} value={typed} onChange={(e) => setTyped(e.target.value)} />
              <button className="btn-danger whitespace-nowrap px-3 py-1.5 text-xs" disabled={typed.trim() !== phrase} onClick={() => void live(true)}>Unlock live</button>
            </div>
          ))}
      </div>
    </Glass>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Guardrails() {
  const rules = useStore((s) => s.rules);
  const params = useStore((s) => s.params);
  const beginner = useStore((s) => s.beginner);
  const maxLev = useStore((s) => s.maxLeverage);
  const [r, setR] = useState<Rules | null>(rules);
  const [p, setP] = useState<Params | null>(params);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const first = useRef(true);
  useEffect(() => { if (rules && !r) setR(rules); if (params && !p) setP(params); }, [rules, params, r, p]);
  const dr = useDebounced(r, 300);
  const dp = useDebounced(p, 300);
  useEffect(() => {
    if (!dr || !dp) return;
    if (first.current) { first.current = false; return; }
    put<{ ok: boolean; errors: string[] }>("/api/settings", { rules: dr, params: dp, validate_only: true }).then((x) => setErrors(x.errors ?? [])).catch(() => undefined);
  }, [dr, dp]);
  if (!r || !p) return <div className="skeleton h-80 rounded-2xl" />;
  const save = async () => {
    setSaving(true);
    try {
      const x = await put<{ ok: boolean; errors: string[] }>("/api/settings", { rules: r, params: p });
      setErrors(x.errors ?? []);
      if (x.ok) useStore.getState().pushToast({ level: "success", title: "Guardrails saved", message: "AEGIS and the Hunter use the new values from the next candle." });
    } catch { /* api() already toasts */ } finally { setSaving(false); }
  };
  return (
    <Glass className="p-4" title="AEGIS guardrails & strategy" glow="profit" right={
      <div className="flex gap-2">
        <button onClick={() => { setR(rules); setP(params); setErrors([]); }} className="btn-ghost px-3 py-1.5 text-xs">Reset</button>
        <button onClick={() => void save()} disabled={saving || errors.length > 0} className="btn-primary px-4 py-1.5 text-xs">{saving ? "Saving…" : "Save rules"}</button>
      </div>}>
      {errors.length > 0 && (
        <motion.ul initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 space-y-1 rounded-lg border border-loss/40 bg-loss/10 p-2.5 text-[12px] text-rose-200">
          {errors.map((e) => <li key={e}>• {e}</li>)}
        </motion.ul>
      )}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-3">
        {RULE_FIELDS.filter((f) => !beginner || f.basic).map((f) => (
          <label key={f.k} className="text-[11.5px] text-slate-400">
            <span className="flex items-center">{f.k === "leverage" ? `${f.label} ≤ ${maxLev}` : f.label}<Tip text={f.tip} /></span>
            <input type="number" step={f.step} className="input mt-1 py-1.5" value={Number.isFinite(r[f.k]) ? r[f.k] : ""}
              onChange={(e) => setR({ ...r, [f.k]: Number(e.target.value) })} />
          </label>
        ))}
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <label className="flex items-center gap-2 text-[12px] text-slate-300">
            <input type="checkbox" checked={r.session_filter} onChange={(e) => setR({ ...r, session_filter: e.target.checked })} className="accent-emerald-500" />
            Session filter (trade only in)<Tip text="Crypto trades 24/7. When enabled, setups outside the ticked sessions (UTC) are vetoed." />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            {SESSIONS.map((s) => {
              const on = r.allowed_sessions.includes(s);
              return (
                <button key={s} disabled={!r.session_filter} onClick={() => setR({ ...r, allowed_sessions: on ? r.allowed_sessions.filter((x) => x !== s) : [...r.allowed_sessions, s] })}
                  className={`chip transition-colors disabled:opacity-40 ${on ? "border-cyan-neon/50 bg-cyan-500/10 text-cyan-100" : "border-white/10 text-slate-500"}`}>{s.replace("_", " ")}</button>
              );
            })}
          </div>
        </div>
        <div>
          <label className="flex items-center gap-2 text-[12px] text-slate-300">
            <input type="checkbox" checked={r.news_filter} onChange={(e) => setR({ ...r, news_filter: e.target.checked })} className="accent-emerald-500" />
            News-hour filter<Tip text="Vetoes setups whose candle hour (UTC) is in the news hours list." />
          </label>
          <input className="input mt-2 py-1.5" placeholder="News hours UTC, e.g. 12,14" value={r.news_hours_utc.join(",")} disabled={!r.news_filter}
            onChange={(e) => setR({ ...r, news_hours_utc: e.target.value.split(",").map((x) => parseInt(x.trim(), 10)).filter((x) => Number.isInteger(x) && x >= 0 && x < 24) })} />
        </div>
      </div>
      <div className="label mt-5">Liquidity sweep strategy</div>
      <div className="mt-2 grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
        {PARAM_FIELDS.filter((f) => !beginner || f.basic).map((f) => (
          <label key={f.k} className="text-[11.5px] text-slate-400">
            <span className="flex items-center justify-between">
              <span className="flex items-center">{f.label}<Tip text={f.tip} /></span>
              <span className="num text-cyan-200">{p[f.k]}</span>
            </span>
            <input type="range" min={f.min} max={Math.max(f.max, p[f.k])} step={f.step} value={p[f.k]} onChange={(e) => setP({ ...p, [f.k]: Number(e.target.value) })} className="mt-1 w-full accent-cyan-400" />
          </label>
        ))}
      </div>
    </Glass>
  );
}

function Row({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-sm text-slate-200 hover:bg-white/[0.04]">
      {label}
      <span className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-cyan-500/70" : "bg-white/10"}`}>
        <motion.span layout className="absolute top-0.5 h-4 w-4 rounded-full bg-white" style={{ left: on ? 18 : 2 }} />
      </span>
    </button>
  );
}

function Display() {
  const force2D = useStore((s) => s.force2D);
  const sound = useStore((s) => s.sound);
  const beginner = useStore((s) => s.beginner);
  const toggle = useStore((s) => s.toggle);
  const set = useStore((s) => s.set);
  return (
    <Glass className="p-4" title="Display & help">
      <div className="mt-2">
        <Row label="Beginner mode (simplified)" on={beginner} onClick={() => toggle("beginner")} />
        <Row label="Sound effects" on={sound} onClick={() => toggle("sound")} />
        <Row label="2D low-power layout" on={force2D} onClick={() => toggle("force2D")} />
        <button className="btn-ghost mt-2 w-full text-xs" onClick={() => set({ tourOpen: true })}>Replay onboarding tour</button>
        <a className="btn-ghost mt-2 block w-full text-center text-xs" href="?classic">Open classic terminal UI</a>
      </div>
    </Glass>
  );
}

export function SettingsView() {
  return (
    <div className="grid h-full gap-3 overflow-y-auto pb-2 xl:grid-cols-[1.5fr_1fr]">
      <div className="space-y-3">
        <ModeSwitch />
        <Guardrails />
      </div>
      <div className="space-y-3">
        <DeltaStatusCard />
        <DeltaControls />
        <Display />
      </div>
    </div>
  );
}
