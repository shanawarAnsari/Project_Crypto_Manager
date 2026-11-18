import { useEffect, useState } from "react";
import { post, put } from "../api";
import { pushToast, useDesk } from "../store";
import type { Params, Rules } from "../types";

type NumKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

const RULE_FIELDS: { k: NumKey<Rules>; label: string; tip: string; step: number }[] = [
  { k: "risk_per_trade_pct", label: "Risk per trade %", tip: "Share of equity risked between entry and stop; contract size is computed from this. Max 2%.", step: 0.1 },
  { k: "max_risk_per_trade_pct", label: "Max risk per trade %", tip: "Hard ceiling. If one contract would risk more, the trade is vetoed.", step: 0.1 },
  { k: "daily_drawdown_kill_pct", label: "Daily drawdown kill %", tip: "When today's equity drop reaches this, every new signal is vetoed until tomorrow (UTC).", step: 0.5 },
  { k: "max_open_trades", label: "Max open trades", tip: "Maximum simultaneous positions (one per instrument).", step: 1 },
  { k: "min_rr", label: "Minimum RR (1:x)", tip: "Reward to TP1 divided by risk to SL must be at least this.", step: 0.1 },
  { k: "min_confidence", label: "Minimum confidence", tip: "Analyst confidence (1-10) required to trade.", step: 1 },
  { k: "spread_limit_pct", label: "Spread limit %", tip: "Veto when the bid/ask spread exceeds this percentage of price.", step: 0.01 },
  { k: "leverage", label: "Leverage (x)", tip: "Leverage set on Delta before each order. Risk is controlled by stop distance; leverage only sets margin.", step: 1 },
  { k: "cooldown_minutes", label: "Cooldown (minutes)", tip: "After a trade on a level, ignore that same level for this long.", step: 5 }
];

const PARAM_FIELDS: { k: keyof Params; label: string; tip: string; step: number }[] = [
  { k: "min_depth_pct", label: "Min sweep depth %", tip: "How far beyond the level the wick must reach to count as a stop hunt.", step: 0.01 },
  { k: "max_depth_pct", label: "Max sweep depth %", tip: "Deeper than this is treated as a genuine breakout, not a sweep.", step: 0.01 },
  { k: "displacement_mult", label: "Displacement × avg body", tip: "The confirmation candle's body must be at least this many times the average body.", step: 0.1 },
  { k: "confirm_candles", label: "Close back inside within (candles)", tip: "The displacement close must happen within this many candles of the sweep.", step: 1 },
  { k: "sl_buffer_pct", label: "SL buffer %", tip: "Extra distance beyond the wick extreme for the stop.", step: 0.01 },
  { k: "tp1_rr", label: "TP1 RR", tip: "TP1 distance as a multiple of risk; must be at least the Guardian's minimum RR.", step: 0.1 },
  { k: "tp2_min_rr", label: "TP2 minimum RR", tip: "TP2 targets the next liquidity pool at least this many R away.", step: 0.1 },
  { k: "body_lookback", label: "Body lookback (candles)", tip: "Candles used for the average body and volume.", step: 1 },
  { k: "volume_spike_mult", label: "Volume spike ×", tip: "Volume above this multiple of average counts as a spike (bonus).", step: 0.1 },
  { k: "eq_tolerance_pct", label: "Equal highs/lows tolerance %", tip: "Swing points within this distance form an equal-highs/lows pool.", step: 0.01 }
];

function ModeSwitch() {
  const dataSource = useDesk((s) => s.dataSource);
  const execution = useDesk((s) => s.execution);
  const delta = useDesk((s) => s.delta);
  const env = useDesk((s) => s.deltaEnv);
  const [busy, setBusy] = useState(false);
  const setMode = async (body: Record<string, string>) => {
    setBusy(true);
    const r = await post<{ ok: boolean; message?: string }>("/api/mode", body).catch(() => ({ ok: false, message: "Desk unreachable" }));
    pushToast({ level: r.ok ? "success" : "warning", title: r.ok ? "Mode updated" : "Mode unchanged", message: r.message ?? "The desk switched modes." });
    setBusy(false);
  };
  const Btn = ({ on, label, onClick, disabled, title }: { on: boolean; label: string; onClick: () => void; disabled?: boolean; title?: string }) => (
    <button type="button" disabled={disabled || busy} title={title} onClick={onClick} className={`btn ${on ? "btn-primary" : ""}`}>{label}</button>
  );
  return (
    <div className="space-y-3">
      <p className="label">Mode</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 text-xs text-terminal-muted">Market data</span>
        <Btn on={dataSource === "demo"} label="Demo (synthetic)" onClick={() => void setMode({ data_source: "demo" })} disabled={execution === "delta"} />
        <Btn on={dataSource === "delta"} label="Delta India live" onClick={() => void setMode({ data_source: "delta" })} disabled={!delta?.connected} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-28 text-xs text-terminal-muted">Execution</span>
        <Btn on={execution === "paper"} label="Paper engine" onClick={() => void setMode({ execution: "paper" })} />
        <Btn on={execution === "delta"} label={`Delta orders (${env === "testnet" ? "Demo" : "LIVE"})`} onClick={() => void setMode({ execution: "delta" })}
          disabled={!delta?.authenticated} title={!delta?.authenticated ? "Configure and verify your Delta API key first" : ""} />
      </div>
      <p className="text-[11.5px] text-terminal-muted">
        Paper is the default. With <code>DELTA_ENV=testnet</code> orders go to your <b className="text-emerald-300">Delta India Demo account</b>; production orders also require the live unlock below.
      </p>
    </div>
  );
}

function DeltaControls() {
  const instruments = useDesk((s) => s.instruments);
  const env = useDesk((s) => s.deltaEnv);
  const delta = useDesk((s) => s.delta);
  const phrase = useDesk((s) => s.confirmPhrase);
  const [typed, setTyped] = useState("");
  const [inst, setInst] = useState("");
  const [busy, setBusy] = useState(false);
  const testOrder = async () => {
    setBusy(true);
    await post("/api/delta/test-order", { instrument: inst || instruments[0] }).catch(() => undefined);
    setBusy(false);
  };
  const live = async (enable: boolean) => {
    const r = await post<{ ok: boolean; message: string }>("/api/delta/live", { enable, phrase: typed });
    pushToast({ level: r.ok ? (enable ? "error" : "success") : "warning", title: "Live trading", message: r.message });
    setTyped("");
  };
  return (
    <div className="space-y-3">
      <p className="label">Delta India</p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={inst || instruments[0]} onChange={(e) => setInst(e.target.value)}>{instruments.map((i) => <option key={i}>{i}</option>)}</select>
        <button type="button" className="btn" disabled={busy || !delta?.authenticated || env !== "testnet"} onClick={() => void testOrder()}
          title={env !== "testnet" ? "Test orders run on the Demo account only" : ""}>{busy ? "Sending…" : "Send test order (1 contract, then close)"}</button>
      </div>
      {env === "production" && (
        <div className="space-y-2 rounded-md border border-red-500/40 bg-red-500/[0.06] p-3">
          <p className="text-[12px] text-red-200">Real-money account. Orders are refused until you unlock live trading for this session.</p>
          {delta?.live_unlocked
            ? <button type="button" className="btn" onClick={() => void live(false)}>Lock live trading</button>
            : (
              <div className="flex flex-wrap gap-2">
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={`Type: ${phrase}`} className="min-w-[240px]" />
                <button type="button" className="btn btn-danger" disabled={typed.trim() !== phrase} onClick={() => void live(true)}>Unlock live</button>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function NumberField({ label, tip, value, step, onChange }: { label: string; tip: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="field" title={tip}>
      <span className="label">{label}</span>
      <input type="number" step={step} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function Settings() {
  const rules = useDesk((s) => s.rules);
  const params = useDesk((s) => s.params);
  const maxLev = useDesk((s) => s.maxLeverage);
  const [r, setR] = useState<Rules | null>(rules);
  const [p, setP] = useState<Params | null>(params);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => setR(rules), [rules]);
  useEffect(() => setP(params), [params]);
  if (!r || !p) return <p className="p-4 text-terminal-muted">Loading settings…</p>;

  const save = async () => {
    const res = await put<{ ok: boolean; errors: string[] }>("/api/settings", { rules: r, params: p });
    setErrors(res.errors ?? []);
    if (res.ok) pushToast({ level: "success", title: "Settings saved", message: "AEGIS and the Hunter use the new values from the next candle." });
  };

  return (
    <div className="grid gap-6 p-4 xl:grid-cols-3">
      <div className="space-y-6">
        <ModeSwitch />
        <DeltaControls />
      </div>
      <div className="space-y-3">
        <p className="label">AEGIS risk rules</p>
        <div className="grid grid-cols-2 gap-3">
          {RULE_FIELDS.map((f) => <NumberField key={f.k} label={f.k === "leverage" ? `${f.label} ≤ ${maxLev}` : f.label} tip={f.tip} step={f.step} value={r[f.k]} onChange={(v) => setR({ ...r, [f.k]: v })} />)}
        </div>
        <p className="text-[11px] text-terminal-muted">Crypto trades 24/7. Session labels are UTC context only; they never pause scanning or block entries. Overnight is 21:00-00:00 UTC.</p>
        <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={r.news_filter} onChange={(e) => setR({ ...r, news_filter: e.target.checked })} />News filter</label>
        <label className="field" title="Comma-separated UTC hours with high-impact news (e.g. 12,14).">
          <span className="label">News hours (UTC)</span>
          <input value={r.news_hours_utc.join(",")} onChange={(e) => setR({ ...r, news_hours_utc: e.target.value.split(",").map((x) => Number(x.trim())).filter((h) => Number.isInteger(h) && h >= 0 && h < 24) })} />
        </label>
      </div>
      <div className="space-y-3">
        <p className="label">Strategy (Liquidity Sweep)</p>
        <div className="grid grid-cols-2 gap-3">
          {PARAM_FIELDS.map((f) => <NumberField key={f.k} label={f.label} tip={f.tip} step={f.step} value={p[f.k]} onChange={(v) => setP({ ...p, [f.k]: v })} />)}
        </div>
        {errors.length > 0 && <ul className="space-y-1 text-[12px] text-red-300">{errors.map((e) => <li key={e}>• {e}</li>)}</ul>}
        <div className="flex gap-2">
          <button type="button" className="btn btn-primary" onClick={() => void save()}>Save settings</button>
          <button type="button" className="btn" onClick={() => { setR(rules); setP(params); setErrors([]); }}>Reset</button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useDesk((s) => s.toasts);
  const tone = { success: "border-emerald-400/50", info: "border-sky-400/50", warning: "border-amber-400/50", error: "border-red-500/60" };
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-[340px] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`rounded-lg border bg-terminal-panel/95 p-3 shadow-xl ${tone[t.level]}`}>
          <p className="text-[13px] font-semibold text-terminal-text">{t.title}</p>
          <p className="text-[12px] text-terminal-muted">{t.message}</p>
        </div>
      ))}
    </div>
  );
}
