export type AgentStatus = "ok" | "skip" | "veto" | "error";
export type Outcome = "none" | "skipped" | "vetoed" | "taken" | "error";

export interface AgentResult {
  agent: string;
  status: AgentStatus;
  summary: string;
  data: Record<string, unknown>;
  confidence: number;
  timestamp: number;
  latency_ms: number;
  instrument?: string;
  cycle_id?: string;
}

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface Level { name: string; price: number; side: "high" | "low"; strength: number }

export interface Setup {
  signal_id: string; instrument: string; direction: "LONG" | "SHORT"; level: Level; sweep_time: number; confirm_time: number;
  sweep_extreme: number; extension_depth: number; extension_unit: "pct"; displacement_ratio: number; volume_spike: boolean;
  entry_price: number; stop_loss: number; take_profit_1: number; take_profit_2: number; risk_reward_ratio: number; session: string;
}

export interface Decision {
  instrument: string;
  bias: "BULLISH_SWEEP_LONG" | "BEARISH_SWEEP_SHORT" | "NO_TRADE";
  confidence_score: number;
  htf_level_targeted: string;
  sweep_details: { extension_depth: string; displacement_quality: string };
  trade_plan: { entry_price: number; stop_loss: number; take_profit_1: number; take_profit_2: number; risk_reward_ratio: number };
  reasoning: string;
  invalidation_conditions: string[];
}

export interface Check { name: string; passed: boolean; detail: string }

export interface CycleSummary {
  instrument: string; cycle_id: string; outcome: Outcome; ts: number; setup: Setup | null; decision: Decision | null;
  checks: Check[]; levels: Level[]; trace: AgentResult[]; execution: Record<string, unknown>;
}

export interface Kpis {
  equity: number; balance: number; today_pnl: number; today_pnl_pct: number; win_rate: number; trades: number;
  open_risk: number | null; open_risk_pct: number | null; drawdown_pct: number; dd_limit_pct: number; kill_switch: boolean;
}

export interface Position {
  id: string; signal_id: string; instrument: string; direction: "LONG" | "SHORT"; volume: number; initial_volume: number;
  entry_price: number; stop_loss: number; initial_stop: number; take_profit_1: number; take_profit_2: number; opened_at: number;
  unrealized_pnl: number; realized_pnl: number; tp1_hit: boolean; breakeven: boolean; venue: "paper" | "delta"; close_reason: string | null;
}

export interface DeltaIssue { code: string; message: string; fix: string }
export interface AccountState {
  environment: "testnet" | "production";
  wallet: { balance: number; available: number; asset: string } | null;
  equity: number | null;
  positions: Position[];
  fills?: DeltaFill[];
  updated_at: number | null;
  error: string | null;
}
export interface DeltaFill {
  id: string; symbol: string; side: "buy" | "sell"; size: number; price: number; commission: number; notional: number;
  order_id: string | null; role: string; time: number;
}
export type Quotes = Record<string, { mark: number; updated_at: number }>;
export interface DeltaHealth {
  available: boolean; connected: boolean; authenticated: boolean; environment: "testnet" | "production"; issues: DeltaIssue[];
  checked_at: number; ping_ms: number | null; live_unlocked: boolean; allow_live_env: boolean;
  account: { balance: number; available: number; equity: number; asset: string } | null;
  products: Record<string, { id: number; live: boolean; contract_value: number; tick_size: number; max_leverage: number }>;
}

export interface ExecLogRow { ts: number; kind: string; symbol: string; status: string; order_id: string | null; price: number | null; contracts: number | null; message: string }
export interface SessionInfo { session: string; utc: string; ist: string; day_progress: number }

export interface Rules {
  risk_per_trade_pct: number; max_risk_per_trade_pct: number; daily_drawdown_kill_pct: number; max_open_trades: number; min_rr: number;
  min_confidence: number; spread_limit_pct: number; leverage: number; session_filter: boolean; allowed_sessions: string[];
  cooldown_minutes: number; news_filter: boolean; news_hours_utc: number[];
}

export interface Params {
  min_depth_pct: number; max_depth_pct: number; displacement_mult: number; confirm_candles: number; sl_buffer_pct: number;
  tp1_rr: number; tp2_min_rr: number; body_lookback: number; volume_spike_mult: number; eq_tolerance_pct: number;
}

export interface Toast { id: number; level: "success" | "info" | "warning" | "error"; title: string; message: string }

export interface JournalRow { id: number; ts: number; instrument: string; signal_id: string | null; outcome: string; summary: string; trace: AgentResult[] }
export interface TradeRow { id: string; instrument: string; direction: string; venue: string; volume: number; entry: number; exit: number | null; pnl: number; opened_at: number; closed_at: number | null; reason: string | null }

export interface BacktestResult {
  instrument: string; source: "synthetic" | "delta"; days: number; candles: number; elapsed_s: number;
  stats: { trades: number; win_rate: number; profit_factor: number; max_drawdown_pct: number; net_pnl: number; return_pct: number;
    avg_win: number; avg_loss: number; expectancy: number; final_equity: number; starting_balance: number };
  decisions: { taken: number; vetoed: number };
  veto_reasons: Record<string, number>;
  equity_curve: { time: number; equity: number }[];
  monthly: { month: string; pnl: number; pct: number }[];
  trades: { time: number; closed: number; direction: string; entry: number; exit: number | null; pnl: number; reason: string | null }[];
  disclaimer: string;
}

export const AGENTS: { name: string; role: string; color: string; blurb: string }[] = [
  { name: "Scout", role: "Data", color: "#22d3ee", blurb: "Pulls 5M candles (resampled to 15M/4H/Daily), spread and account state from Delta India or the demo feed." },
  { name: "Cartographer", role: "Liquidity", color: "#38bdf8", blurb: "Maps PDH/PDL, Asian range, 4H swings and equal highs/lows where stops rest." },
  { name: "Hunter", role: "Sweep", color: "#a78bfa", blurb: "Detects a wick through a level plus a displacement close back inside the range." },
  { name: "Analyst", role: "LLM", color: "#8b5cf6", blurb: "Reviews the candidate and returns strict JSON. It can only refine or reject." },
  { name: "Guardian", role: "AEGIS", color: "#10b981", blurb: "Hard vetoes: spread, drawdown, RR, confidence, cooldown, contract sizing, margin." },
  { name: "Executioner", role: "Execution", color: "#f59e0b", blurb: "Sends approved orders to paper or Delta India with an exchange bracket, BE and partials." },
  { name: "Chronicler", role: "Journal", color: "#f472b6", blurb: "Logs every decision with the full trace and writes the end-of-day review." }
];
