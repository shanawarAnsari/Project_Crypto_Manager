/** The seven desk agents. Each implements run(ctx) and returns an AgentResult; failures are isolated per agent. */
import type { Analyst } from "./analyst.js";
import type { ChatModel } from "./analyst.js";
import { resample, specFor } from "./market.js";
import { evaluate, type GuardianState, type RiskRules } from "./risk.js";
import { detectLatest, mapLiquidity, type StrategyParams } from "./strategy.js";
import type { DecisionRow, DeskDatabase, TradeRow } from "./db.js";
import type { OrderResult } from "./delta-bridge.js";
import type { PaperEngine } from "./paper-engine.js";
import type { AgentResult, AnalystDecision, Bar, Check, DataSource, ExecutionVenue, LiquidityLevel, Outcome, Setup, Toast } from "./types.js";

export const PIPELINE_ORDER = ["Scout", "Cartographer", "Hunter", "Analyst", "Guardian", "Executioner", "Chronicler"] as const;

/** Everything one orchestrator cycle needs from the desk. Implemented by `Desk`. */
export interface DeskServices {
  readonly params: StrategyParams;
  readonly rules: RiskRules;
  readonly guardian: GuardianState;
  readonly analyst: Analyst;
  readonly paper: PaperEngine;
  readonly db: DeskDatabase;
  readonly dataSource: DataSource;
  readonly execution: ExecutionVenue;
  bars(instrument: string, n: number): Bar[];
  spreadPct(instrument: string): Promise<number>;
  equity(): number;
  availableMargin(): number;
  openTradeCount(): number;
  hasPosition(instrument: string): boolean;
  clock(): number;
  toast(t: Toast): void;
  sendDeltaOrder(ctx: CycleContext): Promise<OrderResult>;
  onTradePlaced(ctx: CycleContext, venue: ExecutionVenue, price: number, contracts: number): void;
}

export interface CycleContext {
  instrument: string;
  cycleId: string;
  bars5: Bar[];
  bars15: Bar[];
  bars4h: Bar[];
  barsD: Bar[];
  spreadPct: number;
  equity: number;
  levels: LiquidityLevel[];
  setups: Setup[];
  setup: Setup | null;
  decision: AnalystDecision | null;
  checks: Check[];
  contracts: number;
  riskAmount: number;
  approved: boolean;
  execution: Record<string, unknown>;
  trace: AgentResult[];
  halted: boolean;
  outcome: Outcome;
}

export function newContext(instrument: string, cycleId: string): CycleContext {
  return {
    instrument, cycleId, bars5: [], bars15: [], bars4h: [], barsD: [], spreadPct: 0, equity: 0, levels: [], setups: [],
    setup: null, decision: null, checks: [], contracts: 0, riskAmount: 0, approved: false, execution: {}, trace: [], halted: false, outcome: "none"
  };
}

type AgentOutput = Omit<AgentResult, "agent" | "timestamp" | "latency_ms" | "data" | "confidence"> & { data?: Record<string, unknown>; confidence?: number };

export abstract class Agent {
  abstract readonly name: string;
  abstract readonly role: string;
  protected abstract exec(ctx: CycleContext, svc: DeskServices): Promise<AgentOutput>;

  async run(ctx: CycleContext, svc: DeskServices): Promise<AgentResult> {
    const t0 = performance.now();
    let res: AgentOutput;
    try {
      res = await this.exec(ctx, svc);
    } catch (err) {
      res = { status: "error", summary: `${this.name} error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
      ctx.halted = true;
      ctx.outcome = "error";
    }
    const out: AgentResult = {
      agent: this.name, status: res.status, summary: res.summary, data: res.data ?? {}, confidence: res.confidence ?? 0,
      timestamp: Date.now() / 1000, latency_ms: Math.round((performance.now() - t0) * 10) / 10
    };
    ctx.trace.push(out);
    return out;
  }
}

export class ScoutAgent extends Agent {
  readonly name = "Scout";
  readonly role = "Data";
  protected async exec(ctx: CycleContext, svc: DeskServices): Promise<AgentOutput> {
    const bars = svc.bars(ctx.instrument, 2500);
    if (bars.length < 100) {
      ctx.halted = true;
      return { status: "error", summary: `Not enough ${ctx.instrument} data (${bars.length} candles).` };
    }
    ctx.spreadPct = await svc.spreadPct(ctx.instrument);
    ctx.bars5 = bars;
    ctx.bars15 = resample(bars, 900);
    ctx.bars4h = resample(bars, 4 * 3600);
    ctx.barsD = resample(bars, 86_400);
    ctx.equity = svc.equity();
    const last = bars.at(-1)!;
    return {
      status: "ok", confidence: 1,
      summary: `${ctx.instrument} ${last.close} · spread ${ctx.spreadPct.toFixed(4)}% · ${bars.length} bars (${svc.dataSource === "delta" ? "Delta India" : "demo"})`,
      data: { source: svc.dataSource, last, spread_pct: ctx.spreadPct, equity: ctx.equity, bars: { "5M": bars.length, "15M": ctx.bars15.length, "4H": ctx.bars4h.length, D: ctx.barsD.length } }
    };
  }
}

export class CartographerAgent extends Agent {
  readonly name = "Cartographer";
  readonly role = "Liquidity Mapper";
  protected async exec(ctx: CycleContext, svc: DeskServices): Promise<AgentOutput> {
    // map from history that excludes the live sweep window so the sweep cannot redefine its own level
    const hist = ctx.bars5.slice(-864, -(svc.params.confirm_candles + 1));
    ctx.levels = mapLiquidity(hist, svc.params);
    const price = ctx.bars5.at(-1)!.close;
    const above = ctx.levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price)[0];
    const below = ctx.levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price)[0];
    const nearest = [above && `${above.name} ${above.price} above`, below && `${below.name} ${below.price} below`].filter(Boolean);
    return { status: "ok", confidence: 1, summary: `${ctx.levels.length} liquidity pools mapped. ${nearest.join(" · ")}`, data: { levels: ctx.levels } };
  }
}

export class HunterAgent extends Agent {
  readonly name = "Hunter";
  readonly role = "Sweep Detector";
  protected async exec(ctx: CycleContext, svc: DeskServices): Promise<AgentOutput> {
    ctx.setups = detectLatest(ctx.bars5, ctx.instrument, ctx.levels, svc.params);
    if (!ctx.setups.length) {
      ctx.halted = true;
      return { status: "skip", summary: "Scanning: no sweep + displacement on the last close." };
    }
    const best = ctx.setups.reduce((a, b) => (b.level.strength > a.level.strength || (b.level.strength === a.level.strength && b.displacement_ratio > a.displacement_ratio) ? b : a));
    ctx.setup = best;
    return {
      status: "ok", confidence: Math.min(1, best.displacement_ratio / 3),
      summary: `${best.direction} candidate: ${best.level.name} ${best.level.price} swept by ${best.extension_depth}%, displacement ${best.displacement_ratio.toFixed(2)}x avg body.`,
      data: { setup: best, candidates: ctx.setups.length }
    };
  }
}

export class AnalystAgent extends Agent {
  readonly name = "Analyst";
  readonly role = "LLM";
  protected async exec(ctx: CycleContext, svc: DeskServices): Promise<AgentOutput> {
    const setup = ctx.setup!;
    const prompt = svc.analyst.prompt(setup, { spreadPct: ctx.spreadPct, bars5: ctx.bars5, bars4h: ctx.bars4h, levels: ctx.levels });
    const out = await svc.analyst.decide(setup, prompt, svc.params);
    if (out.warning) svc.toast({ level: "warning", ...out.warning });
    ctx.decision = out.decision;
    const d = out.decision;
    const data = { decision: d, source: out.source, notes: out.notes };
    if (d.bias === "NO_TRADE") {
      ctx.halted = true;
      ctx.outcome = "skipped";
      return { status: "veto", confidence: d.confidence_score / 10, summary: `NO_TRADE (${out.source}). ${d.reasoning}`, data };
    }
    return { status: "ok", confidence: d.confidence_score / 10, summary: `${d.bias} · confidence ${d.confidence_score}/10 (${out.source}). ${d.reasoning}`, data };
  }
}

export class GuardianAgent extends Agent {
  readonly name = "Guardian";
  readonly role = "AEGIS Risk";
  protected async exec(ctx: CycleContext, svc: DeskServices): Promise<AgentOutput> {
    const setup = ctx.setup!;
    const plan = ctx.decision!.trade_plan;
    const { checks, contracts, riskAmount } = evaluate(svc.rules, svc.guardian, {
      instrument: ctx.instrument, direction: setup.direction, entry: plan.entry_price, stop: plan.stop_loss, tp1: plan.take_profit_1,
      confidence: ctx.decision!.confidence_score, session: setup.session, spreadPct: ctx.spreadPct, equity: ctx.equity,
      availableMargin: svc.availableMargin(), openTrades: svc.openTradeCount(), instrumentHasPosition: svc.hasPosition(ctx.instrument),
      signalId: setup.signal_id, levelKey: `${ctx.instrument}:${setup.level.name}`, candleHourUtc: new Date(setup.confirm_time * 1000).getUTCHours(),
      analystBias: ctx.decision!.bias, spec: specFor(ctx.instrument), now: svc.clock()
    });
    ctx.checks = checks;
    ctx.contracts = contracts;
    ctx.riskAmount = riskAmount;
    svc.guardian.processed_ids.add(setup.signal_id);
    const failed = checks.filter((c) => !c.passed);
    if (failed.length) {
      ctx.halted = true;
      ctx.outcome = "vetoed";
      return { status: "veto", summary: `VETO: ${failed.map((c) => `${c.name}: ${c.detail}`).join("; ")}`, data: { checks, contracts } };
    }
    ctx.approved = true;
    svc.guardian.recent_signals.set(`${ctx.instrument}:${setup.level.name}`, svc.clock());
    return { status: "ok", confidence: 1, summary: `APPROVED: all ${checks.length} checks passed. ${contracts} contracts, risking $${riskAmount.toFixed(2)}.`, data: { checks, contracts, risk_amount: riskAmount } };
  }
}

export class ExecutionerAgent extends Agent {
  readonly name = "Executioner";
  readonly role = "Execution";
  protected async exec(ctx: CycleContext, svc: DeskServices): Promise<AgentOutput> {
    // Hard gate: nothing executes without Guardian approval, regardless of Analyst output.
    if (!ctx.approved || !ctx.setup || !ctx.decision) {
      ctx.halted = true;
      return { status: "skip", summary: "Not approved by Guardian: nothing sent." };
    }
    const setup = ctx.setup;
    const plan = ctx.decision.trade_plan;
    if (svc.execution === "delta") {
      const res = await svc.sendDeltaOrder(ctx);
      ctx.execution = { venue: "delta", ...res };
      if (!res.ok) {
        ctx.outcome = res.duplicate ? "vetoed" : "error";
        return { status: res.duplicate ? "skip" : "error", summary: `Delta: ${res.message}`, data: ctx.execution };
      }
      ctx.outcome = "taken";
      svc.onTradePlaced(ctx, "delta", res.price ?? plan.entry_price, res.contracts ?? ctx.contracts);
      return { status: "ok", confidence: 1, summary: `${res.message} · ${setup.direction} ${res.contracts} ${ctx.instrument} @ ${res.price}`, data: ctx.execution };
    }
    const pos = svc.paper.open({
      signalId: setup.signal_id, instrument: ctx.instrument, direction: setup.direction, volume: ctx.contracts, price: plan.entry_price,
      sl: plan.stop_loss, tp1: plan.take_profit_1, tp2: plan.take_profit_2, ts: setup.confirm_time
    });
    ctx.execution = { venue: "paper", position: pos };
    ctx.outcome = "taken";
    svc.onTradePlaced(ctx, "paper", pos.entry_price, pos.volume);
    return {
      status: "ok", confidence: 1,
      summary: `Paper ${setup.direction} ${pos.volume} contracts ${ctx.instrument} @ ${pos.entry_price} · SL ${pos.stop_loss} · TP1 ${pos.take_profit_1} · TP2 ${pos.take_profit_2}`,
      data: ctx.execution
    };
  }
}

export class ChroniclerAgent extends Agent {
  readonly name = "Chronicler";
  readonly role = "Journal";
  protected async exec(ctx: CycleContext, svc: DeskServices): Promise<AgentOutput> {
    if (!ctx.setup) return { status: "skip", summary: "Nothing to journal this cycle." };
    const outcome = ctx.outcome === "none" ? "skipped" : ctx.outcome;
    let summary = [...ctx.trace].reverse().find((r) => r.status === "veto" || r.status === "error")?.summary ?? outcome;
    if (outcome === "taken") summary = ctx.trace.find((r) => r.agent === "Executioner")?.summary ?? "Trade taken";
    const id = svc.db.logDecision(ctx.instrument, ctx.setup.signal_id, outcome, summary, ctx.trace);
    return { status: "ok", confidence: 1, summary: `Journaled #${id}: ${outcome.toUpperCase()} · ${ctx.setup.signal_id}`, data: { journal_id: id, outcome } };
  }
}

export function createAgents(): Agent[] {
  return [new ScoutAgent(), new CartographerAgent(), new HunterAgent(), new AnalystAgent(), new GuardianAgent(), new ExecutionerAgent(), new ChroniclerAgent()];
}

/** End-of-day review. Uses the LLM when configured, otherwise a deterministic summary. */
export async function buildDailyReview(decisions: DecisionRow[], trades: TradeRow[], model: ChatModel | null): Promise<string> {
  const taken = decisions.filter((d) => d.outcome === "taken").length;
  const vetoed = decisions.filter((d) => d.outcome === "vetoed");
  const skipped = decisions.filter((d) => d.outcome === "skipped").length;
  const pnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins = trades.filter((t) => (t.pnl || 0) > 0).length;
  const vetoReasons = new Map<string, number>();
  for (const d of vetoed) {
    for (const part of (d.summary || "").replace("VETO:", "").split(";")) {
      const key = part.split(":")[0]?.trim();
      if (key) vetoReasons.set(key, (vetoReasons.get(key) ?? 0) + 1);
    }
  }
  const topVeto = [...vetoReasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const stats = `${decisions.length} decisions: ${taken} taken, ${vetoed.length} vetoed, ${skipped} skipped. ${trades.length} trades closed, ${wins} winners, net P/L $${pnl.toFixed(2)}.`;
  if (model) {
    try {
      const text = (await model.complete(
        "You are the Chronicler of an educational crypto trading journal. Write a calm, factual end-of-day review in 4-6 sentences: what happened, what the risk guardian protected against, one process lesson. Never promise profits.",
        [{ role: "user", content: `Stats: ${stats} Most common veto: ${topVeto}. Sample decisions: ${JSON.stringify(decisions.slice(-8).map((d) => d.summary))}` }],
        1024
      )).trim();
      if (text) return text;
    } catch {
      // fall back to the deterministic review
    }
  }
  const lesson = topVeto
    ? `The Guardian's most frequent veto was '${topVeto}', a reminder that patience is part of the edge.`
    : "No vetoes today: keep validating that setups meet every rule rather than assuming they will.";
  const tone = pnl > 0 ? "a green day" : pnl === 0 ? "a flat day" : "a red day, which is a normal part of any edge";
  const day = new Date().toUTCString().slice(5, 16);
  return `${day} review: ${stats} Overall it was ${tone}. ${lesson} Process over outcome: every trade risked a fixed fraction and every stop was set before entry.`;
}
