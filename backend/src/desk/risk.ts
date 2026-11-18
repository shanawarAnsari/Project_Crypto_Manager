/**
 * AEGIS risk rules: hard-coded vetoes and position sizing in Delta contracts.
 * Nothing reaches execution unless every check passes. The Analyst can only lower confidence or reject.
 */
import type { InstrumentSpec } from "./market.js";
import type { Check, Direction } from "./types.js";

export interface RiskRules {
  risk_per_trade_pct: number;
  max_risk_per_trade_pct: number;
  daily_drawdown_kill_pct: number;
  max_open_trades: number;
  min_rr: number;
  min_confidence: number;
  spread_limit_pct: number;
  leverage: number;
  session_filter: boolean;
  allowed_sessions: string[];
  cooldown_minutes: number;
  news_filter: boolean;
  news_hours_utc: number[];
}

export const DEFAULT_RULES: Readonly<RiskRules> = Object.freeze({
  risk_per_trade_pct: 1.0,
  max_risk_per_trade_pct: 2.0,
  daily_drawdown_kill_pct: 4.0,
  max_open_trades: 2,
  min_rr: 2.0,
  min_confidence: 7,
  spread_limit_pct: 0.05,
  leverage: 10,
  session_filter: false,
  allowed_sessions: ["ASIAN", "LONDON", "NEW_YORK", "OFF_HOURS"],
  cooldown_minutes: 30,
  news_filter: true,
  news_hours_utc: []
});

const SESSIONS = ["ASIAN", "LONDON", "NEW_YORK", "OFF_HOURS"];

/** Merge user-supplied values onto rules, coercing types; unknown keys are ignored. */
export function mergeRules(base: RiskRules, values: Record<string, unknown>): RiskRules {
  const next: RiskRules = { ...base, allowed_sessions: [...base.allowed_sessions], news_hours_utc: [...base.news_hours_utc] };
  for (const [key, raw] of Object.entries(values)) {
    if (!(key in next)) continue;
    const k = key as keyof RiskRules;
    if (k === "session_filter" || k === "news_filter") next[k] = Boolean(raw);
    else if (k === "allowed_sessions") next[k] = Array.isArray(raw) ? raw.map(String).filter((s) => SESSIONS.includes(s)) : next[k];
    else if (k === "news_hours_utc") next[k] = Array.isArray(raw) ? raw.map(Number).filter((h) => Number.isInteger(h) && h >= 0 && h < 24) : next[k];
    else {
      const num = Number(raw);
      if (Number.isFinite(num)) (next as unknown as Record<string, number>)[k] = k === "max_open_trades" || k === "min_confidence" || k === "cooldown_minutes" ? Math.round(num) : num;
    }
  }
  return next;
}

/** Human-readable validation errors for proposed rules. */
export function validateRules(r: RiskRules, maxLeverage: number): string[] {
  const errors: string[] = [];
  if (!(r.risk_per_trade_pct >= 0.1 && r.risk_per_trade_pct <= 2)) errors.push("Risk per trade must be between 0.1% and 2%.");
  if (r.risk_per_trade_pct > r.max_risk_per_trade_pct) errors.push("Risk per trade cannot exceed the max risk per trade.");
  if (!(r.max_risk_per_trade_pct >= 0.5 && r.max_risk_per_trade_pct <= 2)) errors.push("Max risk per trade is capped at 2%.");
  if (!(r.daily_drawdown_kill_pct >= 1 && r.daily_drawdown_kill_pct <= 10)) errors.push("Daily drawdown kill must be between 1% and 10%.");
  if (!(r.max_open_trades >= 1 && r.max_open_trades <= 10)) errors.push("Max open trades must be between 1 and 10.");
  if (!(r.min_rr >= 1)) errors.push("Minimum RR cannot be below 1:1.");
  if (!(r.min_confidence >= 1 && r.min_confidence <= 10)) errors.push("Minimum confidence must be between 1 and 10.");
  if (!(r.spread_limit_pct > 0 && r.spread_limit_pct <= 1)) errors.push("Spread limit must be between 0% and 1%.");
  if (!(r.leverage >= 1 && r.leverage <= maxLeverage)) errors.push(`Leverage must be between 1x and ${maxLeverage}x.`);
  if (r.cooldown_minutes < 0) errors.push("Cooldown cannot be negative.");
  return errors;
}

/** Whole contracts that risk `riskPct` of equity between entry and stop. Returns [contracts, riskAmount]. */
export function contractSize(equity: number, riskPct: number, entry: number, stop: number, spec: InstrumentSpec): [number, number] {
  const dist = Math.abs(entry - stop);
  if (!(dist > 0) || !(equity > 0)) return [0, 0];
  const lossPerContract = dist * spec.contractValue;
  const raw = equity * riskPct / 100 / lossPerContract;
  if (raw < spec.minContracts) return [0, 0];
  const contracts = Math.min(Math.floor(raw + 1e-9), spec.maxContracts);
  return [contracts, Math.round(contracts * lossPerContract * 100) / 100];
}

export interface GuardianState {
  kill_switch: boolean;
  day_start_equity: number;
  day_key: string;
  recent_signals: Map<string, number>;
  processed_ids: Set<string>;
}

export function newGuardianState(): GuardianState {
  return { kill_switch: false, day_start_equity: 0, day_key: "", recent_signals: new Map(), processed_ids: new Set() };
}

export interface EvaluateInput {
  instrument: string;
  direction: Direction;
  entry: number;
  stop: number;
  tp1: number;
  confidence: number;
  session: string;
  spreadPct: number;
  equity: number;
  availableMargin: number;
  openTrades: number;
  instrumentHasPosition: boolean;
  signalId: string;
  levelKey: string;
  candleHourUtc: number;
  analystBias: string;
  spec: InstrumentSpec;
  now: number;
}

/** Run every AEGIS check. Approved iff all checks pass. */
export function evaluate(rules: RiskRules, state: GuardianState, x: EvaluateInput): { checks: Check[]; contracts: number; riskAmount: number } {
  const checks: Check[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  add("Kill switch", !state.kill_switch, state.kill_switch ? "Kill switch engaged: no new orders." : "Off");
  add("Analyst bias", x.analystBias !== "NO_TRADE", x.analystBias === "NO_TRADE" ? "Analyst returned NO_TRADE." : x.analystBias);
  add("Spread", x.spreadPct <= rules.spread_limit_pct, `${x.spreadPct.toFixed(4)}% (limit ${rules.spread_limit_pct}%)`);

  const dd = state.day_start_equity > 0 ? Math.max(0, (state.day_start_equity - x.equity) / state.day_start_equity * 100) : 0;
  add("Daily drawdown", dd < rules.daily_drawdown_kill_pct, `${dd.toFixed(2)}% today (kill at ${rules.daily_drawdown_kill_pct}%)`);
  add("Max open trades", x.openTrades < rules.max_open_trades && !x.instrumentHasPosition,
    x.instrumentHasPosition ? `${x.instrument} already has an open position` : `${x.openTrades} open (max ${rules.max_open_trades})`);

  const risk = Math.abs(x.entry - x.stop);
  const rr = risk > 0 ? Math.abs(x.tp1 - x.entry) / risk : 0;
  const geomOk = (x.direction === "LONG" && x.stop < x.entry && x.entry < x.tp1) || (x.direction === "SHORT" && x.stop > x.entry && x.entry > x.tp1);
  // Tolerance absorbs tick rounding of entry/SL/TP (a 1:2 plan may compute as 1:1.9998 after rounding).
  add("Risk:Reward", geomOk && rr + 1e-3 >= rules.min_rr, geomOk ? `1:${rr.toFixed(2)} (min 1:${rules.min_rr})` : "Invalid SL/TP geometry");
  add("Confidence", x.confidence >= rules.min_confidence, `${x.confidence}/10 (min ${rules.min_confidence})`);

  if (x.spec.sessionsMatter) {
    const ok = rules.allowed_sessions.includes(x.session);
    add("Session", ok, `${x.session} (${ok ? "allowed" : `allowed: ${rules.allowed_sessions.join("/") || "none"}`})`);
  } else {
    add("Session", true, `${x.session} (context only; crypto trades 24/7)`);
  }

  const newsHit = rules.news_filter && rules.news_hours_utc.includes(x.candleHourUtc);
  add("News filter", !newsHit, newsHit ? "High-impact news hour" : "Clear");

  const dup = state.processed_ids.has(x.signalId);
  const last = state.recent_signals.get(x.levelKey);
  const cooling = last !== undefined && x.now - last < rules.cooldown_minutes * 60;
  add("Duplicate / cooldown", !dup && !cooling, dup ? "Duplicate signal" : cooling ? "Level on cooldown" : "Fresh signal");

  const riskPct = Math.min(rules.risk_per_trade_pct, rules.max_risk_per_trade_pct);
  const [contracts, riskAmount] = contractSize(x.equity, riskPct, x.entry, x.stop, x.spec);
  if (contracts > 0 && x.equity > 0 && riskAmount / x.equity * 100 > rules.max_risk_per_trade_pct + 1e-6) {
    add("Position size", false, `Minimum size risks ${(riskAmount / x.equity * 100).toFixed(2)}% (> ${rules.max_risk_per_trade_pct}%)`);
  } else {
    add("Position size", contracts > 0, contracts > 0
      ? `${contracts} contracts (${(contracts * x.spec.contractValue).toPrecision(4)} ${x.instrument.replace(/USD$/, "")}) risking $${riskAmount.toFixed(2)} (${riskPct}%)`
      : "Stop too wide for one contract at this risk");
  }

  const margin = contracts * x.spec.contractValue * x.entry / rules.leverage;
  add("Margin", contracts === 0 || margin <= x.availableMargin,
    `$${margin.toFixed(2)} needed at ${rules.leverage}x (available $${x.availableMargin.toFixed(2)})`);

  return { checks, contracts, riskAmount };
}
