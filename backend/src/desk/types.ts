export type AgentStatus = "ok" | "skip" | "veto" | "error";
export type Direction = "LONG" | "SHORT";
export type Bias = "BULLISH_SWEEP_LONG" | "BEARISH_SWEEP_SHORT" | "NO_TRADE";
export type Outcome = "none" | "skipped" | "vetoed" | "taken" | "error";
export type DataSource = "demo" | "delta";
export type ExecutionVenue = "paper" | "delta";

/** 5-minute OHLCV bar; `time` is the bar open in unix seconds (UTC). */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AgentResult {
  agent: string;
  status: AgentStatus;
  summary: string;
  data: Record<string, unknown>;
  confidence: number;
  timestamp: number;
  latency_ms: number;
}

/** A price where resting stop-losses (liquidity) are likely to sit. */
export interface LiquidityLevel {
  name: string;
  price: number;
  side: "high" | "low";
  strength: number;
}

/** A rule-based sweep candidate produced by the Hunter (exact numbers). */
export interface Setup {
  signal_id: string;
  instrument: string;
  direction: Direction;
  level: LiquidityLevel;
  sweep_time: number;
  confirm_time: number;
  sweep_extreme: number;
  extension_depth: number;
  extension_unit: "pct";
  displacement_ratio: number;
  volume_spike: boolean;
  entry_price: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number;
  risk_reward_ratio: number;
  session: string;
}

export interface TradePlan {
  entry_price: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number;
  risk_reward_ratio: number;
}

/** Strict schema the Analyst must return. */
export interface AnalystDecision {
  instrument: string;
  bias: Bias;
  confidence_score: number;
  htf_level_targeted: string;
  sweep_details: { extension_depth: string; displacement_quality: string };
  trade_plan: TradePlan;
  reasoning: string;
  invalidation_conditions: string[];
}

export interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

/** A paper or Delta position as shown in the UI. Volume is in exchange contracts. */
export interface Position {
  id: string;
  signal_id: string;
  instrument: string;
  direction: Direction;
  volume: number;
  initial_volume: number;
  entry_price: number;
  stop_loss: number;
  initial_stop: number;
  take_profit_1: number;
  take_profit_2: number;
  opened_at: number;
  status: "open" | "closed";
  closed_at: number | null;
  exit_price: number | null;
  realized_pnl: number;
  unrealized_pnl: number;
  tp1_hit: boolean;
  breakeven: boolean;
  venue: ExecutionVenue;
  close_reason: string | null;
}

export interface CycleSummary {
  instrument: string;
  cycle_id: string;
  outcome: Outcome;
  ts: number;
  setup: Setup | null;
  decision: AnalystDecision | null;
  checks: Check[];
  levels: LiquidityLevel[];
  trace: AgentResult[];
  execution: Record<string, unknown>;
}

export interface Toast {
  level: "success" | "info" | "warning" | "error";
  title: string;
  message: string;
}
