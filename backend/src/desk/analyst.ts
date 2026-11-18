/**
 * Analyst: an LLM reviews the Hunter's candidate and returns strict JSON (validated with zod).
 * It may only refine or reject: entry/SL are pinned to the Hunter's numbers and targets are clamped to the
 * candidate's range. Without an API key a deterministic rule-based scorer is used.
 */
import OpenAI from "openai";
import { z } from "zod";
import type { StrategyParams } from "./strategy.js";
import type { AnalystDecision, Bar, LiquidityLevel, Setup, TradePlan } from "./types.js";

export const SYSTEM_PROMPT = `You are the Analyst agent in an educational liquidity-sweep crypto trading desk (Delta Exchange India perpetuals).
A deterministic Hunter agent has detected a candidate stop-hunt reversal. Judge its quality and either confirm
(optionally refine) it or reject it with NO_TRADE.

Rules:
- You may only refine or reject. Never invent prices: entry_price and stop_loss must equal the candidate's.
  take_profit_1 / take_profit_2 may only be moved closer to entry, never beyond the candidate's TP2.
- bias must match the candidate direction (LONG -> BULLISH_SWEEP_LONG, SHORT -> BEARISH_SWEEP_SHORT) or be NO_TRADE.
- confidence_score is an integer 1-10. Use 7+ only for clean sweeps of meaningful levels with strong displacement.
- reasoning: at most 3 sentences.
- Reply with ONE JSON object only, no markdown, matching exactly this schema:
{"instrument": str, "bias": "BULLISH_SWEEP_LONG"|"BEARISH_SWEEP_SHORT"|"NO_TRADE", "confidence_score": int,
 "htf_level_targeted": str, "sweep_details": {"extension_depth": str, "displacement_quality": str},
 "trade_plan": {"entry_price": float, "stop_loss": float, "take_profit_1": float, "take_profit_2": float,
 "risk_reward_ratio": float}, "reasoning": str, "invalidation_conditions": [str]}`;

const DecisionSchema = z.object({
  instrument: z.string(),
  bias: z.enum(["BULLISH_SWEEP_LONG", "BEARISH_SWEEP_SHORT", "NO_TRADE"]),
  confidence_score: z.number().int().min(1).max(10),
  htf_level_targeted: z.string(),
  sweep_details: z.object({ extension_depth: z.string(), displacement_quality: z.string() }),
  trade_plan: z.object({
    entry_price: z.number(), stop_loss: z.number(), take_profit_1: z.number(), take_profit_2: z.number(), risk_reward_ratio: z.number()
  }),
  reasoning: z.string(),
  invalidation_conditions: z.union([z.array(z.string()), z.string()])
}).superRefine((d, ctx) => {
  const p = d.trade_plan;
  if (d.bias === "BULLISH_SWEEP_LONG" && !(p.stop_loss < p.entry_price && p.entry_price < p.take_profit_1)) {
    ctx.addIssue({ code: "custom", message: "long plan must satisfy SL < entry < TP1" });
  }
  if (d.bias === "BEARISH_SWEEP_SHORT" && !(p.stop_loss > p.entry_price && p.entry_price > p.take_profit_1)) {
    ctx.addIssue({ code: "custom", message: "short plan must satisfy SL > entry > TP1" });
  }
});

/** Parse and validate model text into a decision; throws on invalid JSON or schema mismatch. */
export function parseDecision(text: string): AnalystDecision {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) throw new Error("no JSON object in response");
  const parsed = DecisionSchema.parse(JSON.parse(match[0]));
  const sentences = parsed.reasoning.replace(/[!?]/g, ".").split(".").map((s) => s.trim()).filter(Boolean);
  return {
    ...parsed,
    reasoning: sentences.length > 3 ? `${sentences.slice(0, 3).join(". ")}.` : parsed.reasoning.trim(),
    invalidation_conditions: Array.isArray(parsed.invalidation_conditions) ? parsed.invalidation_conditions : [parsed.invalidation_conditions]
  };
}

const biasFor = (s: Setup): "BULLISH_SWEEP_LONG" | "BEARISH_SWEEP_SHORT" => (s.direction === "LONG" ? "BULLISH_SWEEP_LONG" : "BEARISH_SWEEP_SHORT");
const planFor = (s: Setup): TradePlan => ({
  entry_price: s.entry_price, stop_loss: s.stop_loss, take_profit_1: s.take_profit_1, take_profit_2: s.take_profit_2, risk_reward_ratio: s.risk_reward_ratio
});

/** Deterministic rule-based scoring used when no API key is configured (and in backtests). */
export function mockDecision(setup: Setup, params?: Pick<StrategyParams, "min_depth_pct" | "max_depth_pct">): AnalystDecision {
  let score = 4;
  const dq = setup.displacement_ratio >= 2 ? "strong" : setup.displacement_ratio >= 1.5 ? "moderate" : "weak";
  score += dq === "strong" ? 2 : dq === "moderate" ? 1 : 0;
  if (setup.volume_spike) score += 1;
  if (setup.level.strength >= 2 || setup.level.name.includes("+")) score += 1;
  score += 1; // crypto trades around the clock, so every session counts
  const lo = params?.min_depth_pct ?? 0.15;
  const hi = params?.max_depth_pct ?? 0.4;
  if (Math.abs(setup.extension_depth - (lo + hi) / 2) <= (hi - lo) * 0.3) score += 1;
  const conf = Math.max(1, Math.min(10, Math.round(score)));
  const sideWord = setup.direction === "LONG" ? "sell-side" : "buy-side";
  return {
    instrument: setup.instrument,
    bias: biasFor(setup),
    confidence_score: conf,
    htf_level_targeted: `${setup.level.name} @ ${setup.level.price}`,
    sweep_details: { extension_depth: `${setup.extension_depth} %`, displacement_quality: dq },
    trade_plan: planFor(setup),
    reasoning:
      `Price ran ${sideWord} liquidity resting at ${setup.level.name} (${setup.level.price}) by ${setup.extension_depth}% and was rejected back inside the range. ` +
      `The displacement candle body was ${setup.displacement_ratio.toFixed(1)}x the average${setup.volume_spike ? " with a volume spike" : ""}, which suggests trapped breakout traders. ` +
      `Targeting 1:${setup.risk_reward_ratio} at TP1 with the stop beyond the sweep wick at ${setup.stop_loss}.`,
    invalidation_conditions: [`5M close back beyond ${setup.sweep_extreme} (sweep extreme)`, "No follow-through within 3 candles", "High-impact news hour"]
  };
}

/** Enforce "refine or reject only": pin entry/SL, keep targets inside the candidate's range. */
export function clampToCandidate(decision: AnalystDecision, setup: Setup): { decision: AnalystDecision; notes: string[] } {
  const notes: string[] = [];
  const d: AnalystDecision = { ...decision, trade_plan: { ...decision.trade_plan } };
  if (d.bias === "NO_TRADE") return { decision: d, notes };
  if (d.bias !== biasFor(setup)) {
    notes.push("Analyst bias contradicted the candidate direction: treated as NO_TRADE.");
    d.bias = "NO_TRADE";
    return { decision: d, notes };
  }
  const p = d.trade_plan;
  if (Math.abs(p.entry_price - setup.entry_price) > 1e-6 || Math.abs(p.stop_loss - setup.stop_loss) > 1e-6) notes.push("Entry/SL pinned to Hunter's numbers.");
  p.entry_price = setup.entry_price;
  p.stop_loss = setup.stop_loss;
  const sign = setup.direction === "LONG" ? 1 : -1;
  const risk = Math.abs(setup.entry_price - setup.stop_loss);
  const maxDist = (setup.take_profit_2 - setup.entry_price) * sign;
  const inside = (tp: number, fallback: number) => {
    const dist = (tp - setup.entry_price) * sign;
    if (dist <= 0 || dist > maxDist + 1e-9) {
      notes.push(`Target ${tp} outside candidate range: reset to ${fallback}.`);
      return fallback;
    }
    return tp;
  };
  p.take_profit_1 = inside(p.take_profit_1, setup.take_profit_1);
  p.take_profit_2 = inside(p.take_profit_2, setup.take_profit_2);
  if ((p.take_profit_2 - p.take_profit_1) * sign < 0) p.take_profit_2 = p.take_profit_1;
  p.risk_reward_ratio = risk ? Math.round(Math.abs(p.take_profit_1 - p.entry_price) / risk * 100) / 100 : 0;
  return { decision: d, notes };
}

export interface AnalystOutcome {
  decision: AnalystDecision;
  source: string;
  notes: string[];
  warning?: { title: string; message: string };
}

export interface ChatModel {
  complete(system: string, messages: Array<{ role: "user" | "assistant"; content: string }>, maxTokens: number): Promise<string>;
}

/** OpenAI-compatible chat client (NVIDIA NIM, OpenAI, OpenRouter, Anthropic's OpenAI endpoint, local servers...). */
export class OpenAiCompatibleModel implements ChatModel {
  private readonly client: OpenAI;
  constructor(apiKey: string, baseURL: string, private readonly model: string, timeoutMs: number) {
    this.client = new OpenAI({ apiKey, baseURL, timeout: timeoutMs, maxRetries: 1 });
  }
  async complete(system: string, messages: Array<{ role: "user" | "assistant"; content: string }>, maxTokens: number): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: "system", content: system }, ...messages]
    });
    return res.choices[0]?.message?.content ?? "";
  }
}

export class Analyst {
  constructor(private readonly model: ChatModel | null, readonly modelName: string) {}

  get mode(): "llm" | "rules" {
    return this.model ? "llm" : "rules";
  }

  get chat(): ChatModel | null {
    return this.model;
  }

  prompt(setup: Setup, ctx: { spreadPct: number; bars5: readonly Bar[]; bars4h: readonly Bar[]; levels: readonly LiquidityLevel[] }): string {
    const recent = ctx.bars5.slice(-12).map((b) => [b.time, b.open, b.high, b.low, b.close]);
    const h4 = ctx.bars4h.slice(-6);
    const trend = h4.length > 1 && h4.at(-1)!.close > h4[0]!.close ? "up" : "down";
    return JSON.stringify({
      candidate: setup,
      context: {
        venue: "Delta Exchange India perpetual futures", session: setup.session, spread_pct: ctx.spreadPct, h4_trend_last_24h: trend,
        nearby_levels: ctx.levels.slice(0, 12).map((lv) => ({ name: lv.name, price: lv.price, side: lv.side })),
        last_12_5m_candles_t_o_h_l_c: recent
      }
    });
  }

  async decide(setup: Setup, userPrompt: string, params?: StrategyParams): Promise<AnalystOutcome> {
    let decision: AnalystDecision;
    let source = "rule-based";
    let warning: AnalystOutcome["warning"];
    if (this.model) {
      try {
        decision = await this.askModel(userPrompt);
        source = this.modelName;
      } catch (err) {
        if (err instanceof z.ZodError || err instanceof SyntaxError || (err instanceof Error && err.message.startsWith("invalid JSON"))) {
          decision = { ...mockDecision(setup, params), bias: "NO_TRADE", reasoning: "LLM response could not be validated; defaulting to NO_TRADE." };
          source = `${this.modelName} (invalid)`;
        } else {
          decision = mockDecision(setup, params);
          source = "rule-based fallback";
          const status = err instanceof OpenAI.APIError ? err.status : undefined;
          warning = status === 429
            ? { title: "Analyst rate-limited", message: "The Analyst used rule-based scoring for this setup." }
            : { title: "Analyst unavailable", message: `LLM error (${status ?? "network/timeout"}). Rule-based scoring used.` };
        }
      }
    } else {
      decision = mockDecision(setup, params);
    }
    const clamped = clampToCandidate(decision, setup);
    return { decision: clamped.decision, notes: clamped.notes, source, ...(warning ? { warning } : {}) };
  }

  private async askModel(user: string): Promise<AnalystDecision> {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: user }];
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt += 1) { // one retry on invalid JSON
      const text = await this.model!.complete(SYSTEM_PROMPT, messages, 2048);
      try {
        return parseDecision(text);
      } catch (err) {
        lastErr = (err instanceof Error ? err.message : String(err)).slice(0, 400);
        messages.push({ role: "assistant", content: text || "{}" },
          { role: "user", content: `That was not valid against the schema: ${lastErr}. Reply with the corrected JSON object only.` });
      }
    }
    throw new Error(`invalid JSON after retry: ${lastErr}`);
  }
}
