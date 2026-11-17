import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import OpenAI from "openai";
import { z } from "zod";
import type { AiAuditRepository } from "../persistence/repositories.js";
import { MAX_LEVERAGE } from "../domain.js";

const decimalParameter = (maximum: string) => z.string().min(1).max(20)
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/)
  .refine((value) => {
    const decimal = new Decimal(value);
    return decimal.isFinite() && decimal.gt(0) && decimal.lte(maximum);
  });

const DecisionSchema = z.object({
  strategy: z.enum(["meanReversion", "trendBreakout", "gridScalper", "flat"]),
  parameters: z.object({
    maxLeverage: decimalParameter(String(MAX_LEVERAGE)),
    riskPerTrade: decimalParameter("1"),
    stopLoss: decimalParameter("10"),
    riskRewardRatio: decimalParameter("5")
  }).strict(),
  reasoning: z.string().min(1).max(500)
}).strict();

export type AiDecision = z.infer<typeof DecisionSchema>;

export class AiDecisionService {
  private readonly client: OpenAI | null;
  constructor(
    apiKey: string,
    baseUrl: string,
    private readonly model: string,
    private readonly audit: AiAuditRepository,
    client?: OpenAI
  ) {
    this.client = client ?? (apiKey ? new OpenAI({ apiKey, baseURL: baseUrl, timeout: 15_000, maxRetries: 0 }) : null);
  }

  async advise(context: {
    candles: readonly { close: string }[];
    currentStrategy: string;
    operatorInstruction?: string;
    currentParameters?: {
      maxLeverage: string;
      riskPerTrade: string;
      stopLoss: string;
      riskRewardRatio: string;
    };
    marketContext?: Record<string, readonly { close: string }[]>;
  }): Promise<AiDecision> {
    const prompt = JSON.stringify({
      instruction: "Return strict JSON with strategy, parameters (maxLeverage, riskPerTrade, stopLoss, riskRewardRatio as decimal strings), and reasoning. Suggest conservative values that do not exceed currentParameters. Do not instruct order execution or bypass risk controls.",
      currentStrategy: context.currentStrategy,
      parameterConstraints: {
        maxLeverage: `greater than 0 and at most ${MAX_LEVERAGE}`,
        riskPerTrade: "percent, greater than 0 and at most 1",
        stopLoss: "percent, greater than 0 and at most 10",
        riskRewardRatio: "greater than 0 and at most 5"
      },
      operatorInstruction: context.operatorInstruction ?? "",
      currentParameters: context.currentParameters ?? {},
      recentCloses: context.marketContext
        ? Object.fromEntries(Object.entries(context.marketContext).map(([timeframe, candles]) => [
          timeframe, candles.slice(-20).map((candle) => candle.close)
        ]))
        : { "1h": context.candles.slice(-80).map((candle) => candle.close) }
    });
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    if (!this.client) {
      this.audit.record({ model: this.model, promptHash, decision: "unavailable", accepted: false, rejectionReason: "NVIDIA NIM API key is not configured" });
      throw new Error("AI decision service is unavailable: NVIDIA NIM API key is not configured");
    }
    let raw = "";
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You provide strategy and bounded parameter advice only. Return all parameter values as decimal strings. Never propose orders, position sizes, or bypass a safety control." },
          { role: "user", content: prompt }
        ]
      });
      raw = response.choices[0]?.message.content ?? "";
      const parsedJson: unknown = JSON.parse(raw);
      const decision = DecisionSchema.parse(parsedJson);
      this.audit.record({ model: this.model, promptHash, decision: JSON.stringify(decision), accepted: true, rejectionReason: null });
      return decision;
    } catch {
      this.audit.record({ model: this.model, promptHash, decision: "rejected", accepted: false, rejectionReason: "Provider response or schema validation failed" });
      throw new Error("AI decision was rejected: provider response was invalid or unavailable");
    }
  }
}
