export type Environment = "testnet" | "production";
export type AccountEnvironment = "demo" | "live" | "unconfigured";
export type ConnectionState = "connected" | "reconnecting" | "disconnected";
export type Timeframe = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w";
export type AgentTimeframe = "1m" | "5m" | "15m" | "30m" | "1h";
/** Timeframes the backend strategy and AI router evaluate; intraday timeframes are chart-only. */
export type StrategyTimeframe = "1h" | "4h" | "1d" | "1w";
export type LiveChartStatus = "connecting" | "live" | "stale";
export type StrategyName = "meanReversion" | "trendBreakout" | "gridScalper" | "flat";

export interface AgentEvent {
  id: number;
  role: "user" | "assistant" | "activity" | "error";
  message: string;
  createdAt: number;
}

export interface AgentSnapshot {
  timeframe: AgentTimeframe;
  model: string;
  configured: boolean;
  busy: boolean;
  enabled: boolean;
  demoOnly: true;
  lastReviewAt: number | null;
  nextReviewAt: number | null;
  trade: Record<string, unknown> | null;
  events: AgentEvent[];
}

export interface DemoTestEntryPreview {
  token: string;
  expiresAt: number;
  side: "buy" | "sell";
  contracts: string;
  entryPrice: string;
  stopPrice: string;
  takeProfitPrice: string;
  leverage: number;
}

export interface StrategyConfig {
  name: StrategyName;
  parameters: Record<string, string>;
  instruction: string;
}

export interface AiDecisionResponse {
  status: "applied";
  decision: {
    strategy: StrategyName;
    parameters: {
      maxLeverage: string;
      riskPerTrade: string;
      stopLoss: string;
      riskRewardRatio: string;
    };
    reasoning: string;
  };
  applied: true;
  strategy: StrategyConfig;
  appliedParameters: {
    maxLeverage: string;
    riskPerTrade: string;
    stopLoss: string;
    riskRewardRatio: string;
  };
}

export interface SignalPreview {
  strategy: StrategyName;
  signal: {
    strategy: StrategyName;
    side: "buy" | "sell" | null;
    referencePrice: string;
    stopPrice: string | null;
    confidence: number;
    reason: string;
  };
}

export interface Position {
  id: string;
  symbol: string;
  side: "long" | "short";
  quantity: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  leverage: string;
  stopPrice: string | null;
  takeProfitPrice: string | null;
}

export interface Order {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  quantity: string;
  limitPrice: string | null;
  status: string;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  occurredAt: string;
  decision: string;
  reason: string;
  riskApproved: boolean;
}

export interface Trade {
  id: string;
  occurredAt: string;
  timestamp: number;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  realizedPnl: string;
}

export interface Dashboard {
  market: {
    symbol: string;
    markPrice: string;
    fundingRate: string;
    websocketStatus: ConnectionState;
  };
  environment: Environment;
  accountEnvironment: AccountEnvironment;
  executionConfigured: boolean;
  bot: {
    enabled: boolean;
    killSwitch: boolean;
    riskStatus: string;
    riskHaltReason: string;
  };
  accountStatus: "available" | "partial" | "unavailable";
  accountError: string | null;
  portfolio: {
    totalUsd: string;
    totalInr: string;
    holdings: Array<{ asset: string; quantity: string; valueUsd: string; valueInr: string }>;
  } | null;
  portfolioError: string | null;
  account: {
    equity: string;
    availableMargin: string;
    marginUsed: string;
    unrealizedPnl: string;
    realizedPnl: string;
    leverage: string;
    drawdownPercent: string;
    usdInrRate: string;
    equityInr: string;
    availableMarginInr: string;
  };
  positions: Position[];
  orders: Order[];
  audit: AuditEvent[];
  trades: Trade[];
  strategy: StrategyConfig;
}

export interface Candle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface CandleResponse {
  candles: Candle[];
}
