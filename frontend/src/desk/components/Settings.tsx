import { useEffect, useState } from "react";
import { api, post, put } from "../api";
import { loadState, pushToast, useDesk } from "../store";
import type { Rules } from "../types";

type NumKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

const RULE_FIELDS: { k: NumKey<Rules>; label: string; tip: string; step: number }[] = [
  { k: "risk_per_trade_pct", label: "Risk per trade %", tip: "Share of equity risked between entry and stop; contract size is computed from this. Max 2%.", step: 0.1 },
  { k: "max_risk_per_trade_pct", label: "Max risk per trade %", tip: "Hard ceiling. If one contract would risk more, the trade is vetoed.", step: 0.1 },
  { k: "daily_drawdown_kill_pct", label: "Daily drawdown kill %", tip: "When today's equity drop reaches this, every new signal is vetoed until tomorrow (UTC).", step: 0.5 },
  { k: "min_rr", label: "Minimum RR (1:x)", tip: "Require at least this bracket reward per unit of risk.", step: 0.1 },
  { k: "spread_limit_pct", label: "Spread limit %", tip: "Veto when the bid/ask spread exceeds this percentage of price.", step: 0.01 },
  { k: "cooldown_minutes", label: "Cooldown (minutes)", tip: "After a trade on a level, ignore that same level for this long.", step: 5 }
];

function ModeSwitch() {
  const execution = useDesk((s) => s.execution);
  const delta = useDesk((s) => s.delta);
  const env = useDesk((s) => s.deltaEnv);
  const selected = useDesk((s) => s.strategyId);
  const permitted = useDesk(s => s.executionPermitted);
  const paused = useDesk(s => s.paused);
  const connected = useDesk(s => s.connected);
  const [choices, setChoices] = useState<{ id: string; name: string }[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<{ strategies: typeof choices }>("/api/strategies").then(r => { if (active) setChoices(r.strategies); })
      .catch((e: unknown) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, []);
  useEffect(() => setDraft(selected ?? ""), [selected]);
  const command = async (action: "select" | "arm" | "disarm") => {
    if (action === "arm" && !window.confirm(`Enable autonomous Delta Demo orders for ${selected}?`)) return;
    setBusy(true);
    setError("");
    try {
      type Reply = { ok: boolean; message: string };
      const r = action === "select" ? await put<Reply>("/api/strategy", { strategy_id: draft })
        : await post<Reply>("/api/mode", { execution: action === "arm" ? "delta" : "disabled" });
      if (!r.ok) throw new Error(r.message);
      await loadState();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-3">
      <p className="label">Deploy to Delta Demo</p>
      <p className="text-xs">Active candidate: <b>{selected ?? "None"}</b> · Orders {execution === "delta" ? "enabled until paused or a risk/data fault" : "disabled"}</p>
      <label className="field"><span className="label">Strategy candidate</span>
        <select value={draft} disabled={busy || execution === "delta"} onChange={e => setDraft(e.target.value)}>
          <option value="">Select a candidate</option>{choices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn" disabled={busy || !draft || draft === selected || execution === "delta"} onClick={() => void command("select")}>Select strategy</button>
        {execution === "delta" ? <button className="btn btn-danger" disabled={busy} onClick={() => void command("disarm")}>Disable orders</button>
          : <button className="btn btn-primary" disabled={busy || !connected || !permitted || paused || !selected || draft !== selected || !delta?.authenticated || env !== "testnet"} onClick={() => void command("arm")}>Enable demo orders</button>}
      </div>
      <p className="text-[11.5px] text-terminal-muted">Backtest first. Selection alone never enables orders. Once explicitly enabled, the desk may enter autonomously whenever the verified demo account is flat, one position at a time; it waits for exchange positions and protective orders to clear before another entry. Pause or a risk/data fault disarms it.</p>
      {!permitted && <p className="text-xs">Observation only. To permit orders, configure demo credentials and DESK_EXECUTION=delta on the backend, then restart.</p>}
      {paused && <p className="text-xs">Scanning paused. Resume scanning before enabling orders.</p>}
      {error && <p role="alert" className="text-xs text-terminal-red">{error}</p>}
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
  const [r, setR] = useState<Rules | null>(rules);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => setR(rules), [rules]);
  if (!r) return <p className="p-4 text-terminal-muted">Loading settings…</p>;

  const save = async () => {
    const res = await put<{ ok: boolean; errors: string[] }>("/api/settings", { rules: r })
      .catch((e: unknown) => ({ ok: false, errors: [String(e)] }));
    setErrors(res.errors ?? []);
    if (res.ok) pushToast({ level: "success", title: "Settings saved", message: "New risk controls saved. Orders must be re-enabled explicitly." });
  };

  return (
    <div className="grid gap-6 p-4 xl:grid-cols-3">
      <div className="space-y-6">
        <ModeSwitch />
      </div>
      <div className="space-y-3">
        <p className="label">AEGIS risk rules</p>
        <div className="grid grid-cols-2 gap-3">
          {RULE_FIELDS.map((f) => <NumberField key={f.k} label={f.label} tip={f.tip} step={f.step} value={r[f.k]} onChange={(v) => setR({ ...r, [f.k]: v })} />)}
        </div>
        <p className="text-[11px] text-terminal-muted">Crypto trades 24/7. Session labels are UTC context only; they never pause scanning or block entries. Overnight is 21:00-00:00 UTC.</p>
        <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={r.news_filter} onChange={(e) => setR({ ...r, news_filter: e.target.checked })} />News filter</label>
        <label className="field" title="Comma-separated UTC hours with high-impact news (e.g. 12,14).">
          <span className="label">News hours (UTC)</span>
          <input defaultValue={r.news_hours_utc.join(",")} onBlur={(e) => setR({ ...r, news_hours_utc: e.target.value.split(",").map(x => x.trim()).filter(Boolean).map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h < 24) })} />
        </label>
      </div>
      <div className="space-y-3">
        <p className="label">Execution constraints</p>
        <p className="text-xs">One position at a time. Entry requires a verified flat account and no working orders. A stop order cannot guarantee the exit price.</p>
        {errors.length > 0 && <ul className="space-y-1 text-[12px] text-red-300">{errors.map((e) => <li key={e}>• {e}</li>)}</ul>}
        <div className="flex gap-2">
          <button type="button" className="btn btn-primary" onClick={() => void save()}>Save settings</button>
          <button type="button" className="btn" onClick={() => { setR(rules); setErrors([]); }}>Reset</button>
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
