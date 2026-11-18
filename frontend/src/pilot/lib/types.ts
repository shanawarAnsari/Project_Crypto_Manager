import type { AgentResult as DeskAgentResult } from "../../desk/types";

export type {
  AccountState, BacktestResult, Candle, Check, CycleSummary, Decision, DeltaFill, DeltaHealth, DeltaIssue, ExecLogRow, JournalRow, Kpis, Level,
  Params, Position, Quotes, Rules, SessionInfo, Setup, Toast, TradeRow
} from "../../desk/types";

export type AgentName = "Scout" | "Cartographer" | "Hunter" | "Analyst" | "Guardian" | "Executioner" | "Chronicler";
export type AgentStatus = "ok" | "skip" | "veto" | "error";
export type Instrument = string;
export type ViewId = "overview" | "chart" | "signals" | "backtest" | "journal" | "settings";
export type AgentResult = Omit<DeskAgentResult, "agent"> & { agent: AgentName };

export const AGENTS: { name: AgentName; role: string; color: string; blurb: string }[] = [
  { name: "Scout", role: "Data", color: "#22d3ee", blurb: "Pulls 5M candles (resampled to 15M/4H/Daily), spread and account state from Delta Exchange India or the demo feed." },
  { name: "Cartographer", role: "Liquidity Mapper", color: "#38bdf8", blurb: "Maps PDH/PDL, Asian range, 4H swings and equal highs/lows where stops rest." },
  { name: "Hunter", role: "Sweep Detector", color: "#a78bfa", blurb: "Detects a wick through a level plus a displacement close back inside the range." },
  { name: "Analyst", role: "LLM", color: "#8b5cf6", blurb: "Reviews the candidate and returns strict JSON. It can only refine or reject, never invent a trade." },
  { name: "Guardian", role: "AEGIS Risk", color: "#10b981", blurb: "Hard vetoes: spread, drawdown, RR, confidence, session, cooldown, contract sizing, margin." },
  { name: "Executioner", role: "Execution", color: "#f59e0b", blurb: "Sends approved orders to the paper engine or Delta India with an exchange bracket, BE and partials." },
  { name: "Chronicler", role: "Journal", color: "#f472b6", blurb: "Logs every decision with the full trace and writes the end-of-day review." }
];
