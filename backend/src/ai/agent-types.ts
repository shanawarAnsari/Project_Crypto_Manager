import { z } from "zod";
import Decimal from "decimal.js";

export const AGENT_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h"] as const;
export type AgentTimeframe = typeof AGENT_TIMEFRAMES[number];
const price = z.string().regex(/^[1-9]\d*(\.\d+)?$|^0\.\d+$/).max(30);
const summary = z.string().trim().min(1).max(1200);
export const AgentDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("wait"), summary }).strict(),
  z.object({ action: z.literal("hold"), summary }).strict(),
  z.object({ action: z.literal("close"), summary }).strict(),
  z.object({
    action: z.literal("open"), side: z.enum(["buy", "sell"]),
    stopPrice: price, takeProfitPrice: price,
    marginPercent: z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/).max(20)
      .refine((value) => new Decimal(value).gt(0) && new Decimal(value).lte(25)),
    leverage: z.number().min(1).max(2), summary
  }).strict()
]);
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;
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
export interface AgentEvent {
  id: number;
  role: "user" | "assistant" | "activity" | "error";
  message: string;
  createdAt: number;
}
export interface AgentTrade {
  id: string;
  clientOrderId: string;
  closeClientOrderId: string | null;
  exitRequestedAt?: number;
  side: "buy" | "sell";
  contracts: string;
  entryPrice: string;
  stopPrice: string;
  takeProfitPrice: string;
  thesis: string;
  status: "entry_pending" | "open" | "exit_pending" | "closed" | "blocked";
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
  trade: AgentTrade | null;
  events: AgentEvent[];
}
