export const MAX_LEVERAGE = 2;
export const DEMO_MAX_MARGIN_PERCENT = 100;
export const DEMO_MAX_LEVERAGE = 100;
export const DEMO_MAX_PLANNED_LOSS_PERCENT = 30;
export const DEMO_DAILY_LOSS_PERCENT = 50;

export function leverageCeiling(environment: "production" | "testnet"): number {
  return environment === "testnet" ? DEMO_MAX_LEVERAGE : MAX_LEVERAGE;
}
export const TIMEFRAMES = ["1h", "4h", "1d", "1w"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
/** Display-only intervals plus the strategy intervals; strategies never consume intraday chart candles. */
export const CHART_TIMEFRAMES = ["1m", "5m", "15m", "30m", ...TIMEFRAMES] as const;
export type ChartTimeframe = (typeof CHART_TIMEFRAMES)[number];
export const TIMEFRAME_SECONDS: Readonly<Record<ChartTimeframe, number>> = Object.freeze({
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14_400,
  "1d": 86_400,
  "1w": 604_800
});
export type StrategyName = "meanReversion" | "trendBreakout" | "gridScalper" | "flat";
export type Side = "buy" | "sell";

export interface Candle {
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface TradingSignal {
  strategy: StrategyName;
  side: Side | null;
  referencePrice: string;
  stopPrice: string | null;
  confidence: number;
  reason: string;
}

export interface BotState {
  enabled: boolean;
  killSwitch: boolean;
  strategy: StrategyName;
  maxLeverage: number;
  maxDailyLoss: string;
  riskPerTrade: string;
  stopLossPercent: string;
  riskRewardRatio: string;
  instruction: string;
  updatedAt: number;
}

export interface RiskApproval {
  readonly approvalId: string;
  readonly productId: number;
  readonly side: Side;
  readonly quantity: string;
  readonly entryPrice: string;
  readonly leverage: number;
  readonly stopPrice: string;
  readonly takeProfitPrice: string;
  readonly issuedAt: number;
}

export interface EmergencyCloseApproval {
  readonly approvalId: string;
  readonly productId: number;
  readonly intent: "emergency-close";
  readonly issuedAt: number;
}

export interface AgentCloseApproval {
  readonly intent: "agent-close" | "manual-owned-close";
  readonly approvalId: string;
  readonly productId: number;
  readonly side: Side;
  readonly contracts: string;
  readonly issuedAt: number;
}
