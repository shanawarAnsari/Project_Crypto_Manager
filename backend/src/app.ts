import express, { type ErrorRequestHandler, type Express } from "express";
import { z } from "zod";
import {
  CHART_TIMEFRAMES, TIMEFRAMES, MAX_LEVERAGE, DEMO_MAX_LEVERAGE, type ChartTimeframe, type StrategyName, type Timeframe, type TradingSignal
} from "./domain.js";
import type { AppServices } from "./services.js";
import { testnetExecutionConfigured, syncDailyLossCap } from "./services.js";
import { DeltaApiError, type DeltaPortfolioValuation } from "./exchange/delta-client.js";
import { applyAiDecision } from "./ai/apply-decision.js";
import { evaluateStrategy, rebaseSignal } from "./strategy/strategy.js";
import Decimal from "decimal.js";
import type { TradingAgent } from "./ai/trading-agent.js";
import { AGENT_TIMEFRAMES } from "./ai/agent-types.js";

const StrategySchema = z.enum(["meanReversion", "trendBreakout", "gridScalper", "flat"]);
const TIMEFRAME_MILLISECONDS: Readonly<Record<Timeframe, number>> = {
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000
};
const StrategyConfigSchema = z.object({
  name: z.string().min(1).max(40),
  parameters: z.record(z.string(), z.string().max(20)).default({}),
  instruction: z.string().max(500).default("")
}).strict();

function resolveStrategyName(name: string): StrategyName | null {
  const normalized = name.replace(/[\s_-]/g, "").toLowerCase();
  const aliases: Record<string, StrategyName> = {
    meanreversion: "meanReversion",
    trendbreakout: "trendBreakout",
    trendfollowing: "trendBreakout",
    gridscalper: "gridScalper",
    gridscalping: "gridScalper",
    flat: "flat"
  };
  return aliases[normalized] ?? null;
}

function asStrategyConfig(state: ReturnType<AppServices["botState"]["get"]>) {
  return {
    name: state.strategy,
    parameters: {
      riskPerTrade: state.riskPerTrade,
      maxLeverage: String(state.maxLeverage),
      stopLoss: state.stopLossPercent,
      riskRewardRatio: state.riskRewardRatio
    },
    instruction: state.instruction
  };
}

interface DashboardPosition {
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

interface DashboardOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  quantity: string;
  limitPrice: string | null;
  stopOrderType: string | null;
  triggerPrice: string | null;
  status: string;
  createdAt: string;
}

async function forceAiReevaluation(services: AppServices, timeframe: Timeframe) {
  const candles = services.candles.list(timeframe, 80);
  const latestHourlyCandle = services.candles.list("1h", 1).at(-1);
  if (candles.length < 20 || !latestHourlyCandle ||
      latestHourlyCandle.timestamp > Date.now() + 5 * 60_000 ||
      Date.now() - latestHourlyCandle.timestamp > 2 * 60 * 60_000) {
    throw new Error("Recent market candles are unavailable for AI reevaluation");
  }
  const current = services.botState.get();
  const decision = await services.ai.advise({
    candles,
    currentStrategy: current.strategy,
    operatorInstruction: current.instruction,
    currentParameters: {
      maxLeverage: String(current.maxLeverage),
      riskPerTrade: current.riskPerTrade,
      stopLoss: current.stopLossPercent,
      riskRewardRatio: current.riskRewardRatio
    },
    marketContext: Object.fromEntries(TIMEFRAMES.map((period) => [
      period, services.candles.list(period, 20)
    ]))
  });
  const applied = applyAiDecision(decision, services.botState, services.config.maxLeverage);
  return {
    status: "applied" as const,
    decision,
    applied: true,
    strategy: asStrategyConfig(applied.state),
    appliedParameters: applied.parameters
  };
}

function getSignalPreview(services: AppServices): {
  strategy: StrategyName;
  signal: TradingSignal;
} {
  const now = Date.now();
  const state = services.botState.get();
  const closedCandles = services.candles.list("1h", 100).filter((candle) =>
    candle.timestamp + 3_600_000 <= now
  );
  const latestCandle = closedCandles.at(-1);
  const priceUpdatedAt = services.status.getUpdatedAt("market_price");
  const markPrice = priceUpdatedAt !== null && now - priceUpdatedAt <= 120_000
    ? services.status.get("market_price")
    : null;
  if (!latestCandle || now - latestCandle.timestamp > 2 * 3_600_000 || !markPrice) {
    throw new Error("A fresh market price and closed hourly candles are required to preview a signal");
  }
  const marketContext = Object.fromEntries(TIMEFRAMES.map((timeframe) => [
    timeframe,
    services.candles.list(timeframe, 100).filter((candle) =>
      candle.timestamp + TIMEFRAME_MILLISECONDS[timeframe] <= now
    )
  ]));
  const proposed = evaluateStrategy(
    state.strategy,
    closedCandles,
    state.stopLossPercent,
    marketContext
  );
  return {
    strategy: state.strategy,
    signal: rebaseSignal(proposed, markPrice, state.stopLossPercent)
  };
}

export function createApp(services: AppServices, agent?: TradingAgent): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/agent", (_request, response) => {
    if (!agent) { response.status(503).json({ message: "Trading agent is unavailable" }); return; }
    response.json(agent.snapshot());
  });
  app.post("/api/agent/chat", (request, response) => {
    const parsed = z.object({ message: z.string().trim().min(1).max(2000) }).strict().safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ message: "Message must contain 1–2000 characters" }); return; }
    if (!agent) { response.status(503).json({ message: "Trading agent is unavailable" }); return; }
    try { agent.send(parsed.data.message); response.status(202).json({ accepted: true }); }
    catch (error) { response.status(409).json({ message: error instanceof Error ? error.message : "Chat unavailable" }); }
  });
  app.post("/api/agent/settings", (request, response) => {
    const parsed = z.object({ timeframe: z.enum(AGENT_TIMEFRAMES) }).strict().safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ message: "Unsupported agent timeframe" }); return; }
    if (!agent) { response.status(503).json({ message: "Trading agent is unavailable" }); return; }
    response.json(agent.setTimeframe(parsed.data.timeframe));
  });
  app.post("/api/agent/test-entry/preview", async (request, response) => {
    const parsed = z.object({ side: z.enum(["buy", "sell"]), leverage: z.number().int().min(1).max(DEMO_MAX_LEVERAGE).default(1) }).strict().safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ message: "Test entry requires a buy or sell side and whole leverage from 1 to 100" }); return; }
    if (!agent) { response.status(503).json({ message: "Trading agent is unavailable" }); return; }
    try { response.json(await agent.previewTestEntry(parsed.data.side, parsed.data.leverage)); }
    catch (error) { response.status(409).json({ message: error instanceof Error ? error.message : "Test preview unavailable" }); }
  });
  app.post("/api/agent/test-entry/confirm", async (request, response) => {
    const parsed = z.object({ token: z.uuid(), confirmation: z.literal("PLACE_DEMO_TEST_ORDER") }).strict().safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ message: "Explicit Demo test confirmation and a valid token are required" }); return; }
    if (!agent) { response.status(503).json({ message: "Trading agent is unavailable" }); return; }
    try { await agent.confirmTestEntry(parsed.data.token); response.json(agent.snapshot()); }
    catch (error) { response.status(409).json({ message: error instanceof Error ? error.message : "Test entry unavailable" }); }
  });
  app.post("/api/agent/close-all", async (request, response) => {
    const parsed = z.object({ confirmation: z.literal("CLOSE_OWNED_DEMO_BTCUSD") }).strict().safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ message: "Explicit CLOSE_OWNED_DEMO_BTCUSD confirmation is required" }); return; }
    if (!agent) { response.status(503).json({ message: "Trading agent is unavailable" }); return; }
    if (services.config.deltaEnvironment !== "testnet") { response.status(409).json({ message: "Close all positions is Demo-only" }); return; }
    try { await agent.closeAllDemoPositions(); response.json(agent.snapshot()); }
    catch (error) { response.status(409).json({ message: error instanceof Error ? error.message : "Demo close-all failed; inspect exchange exposure" }); }
  });
  app.get("/api/agent/events", (request, response) => {
    if (!agent) { response.status(503).json({ message: "Trading agent is unavailable" }); return; }
    const raw = request.get("last-event-id") ?? request.query.after ?? "0";
    const parsed = z.coerce.number().int().min(0).safeParse(raw);
    if (!parsed.success) { response.status(400).json({ message: "Invalid event cursor" }); return; }
    let cursor = parsed.data;
    response.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    const flush = () => {
      for (const event of agent.repository.events(cursor)) {
        response.write(`id: ${event.id}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.id;
      }
    };
    flush();
    const interval = setInterval(flush, 500);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    response.on("close", () => { clearInterval(interval); clearInterval(heartbeat); });
  });

  app.get("/api/health", (_request, response) => {
    try {
      services.db.prepare("SELECT 1").get();
      response.status(200).json({ status: "ok", database: "ok" });
    } catch {
      response.status(503).json({ status: "error", database: "unavailable" });
    }
  });

  app.get("/api/dashboard", async (_request, response) => {
    const state = services.botState.get();
    const accountEnvironment = !(services.config.deltaApiKey && services.config.deltaApiSecret)
      ? "unconfigured" as const
      : services.config.deltaEnvironment === "production" ? "live" as const : "demo" as const;
    const priceUpdatedAt = services.status.getUpdatedAt("market_price");
    const latestPrice = priceUpdatedAt !== null && Date.now() - priceUpdatedAt <= 120_000
      ? services.status.get("market_price")
      : null;
    const websocketUpdatedAt = services.status.getUpdatedAt("market_websocket");
    const websocketStatus = websocketUpdatedAt !== null && Date.now() - websocketUpdatedAt <= 45_000
      ? services.status.get("market_websocket")
      : "disconnected";
    const fundingUpdatedAt = services.status.getUpdatedAt("funding_rate");
    const fundingRate = fundingUpdatedAt !== null && Date.now() - fundingUpdatedAt <= 120_000
      ? services.status.get("funding_rate")
      : null;
    const recentTrades = services.trades.recent(50);
    let account = {
      equity: "",
      availableMargin: "",
      marginUsed: "",
      unrealizedPnl: "",
      realizedPnl: "",
      leverage: "",
      drawdownPercent: "",
      usdInrRate: "",
      equityInr: "",
      availableMarginInr: ""
    };
    let accountStatus: "available" | "partial" | "unavailable" = "unavailable";
    let portfolio: DeltaPortfolioValuation | null = null;
    let portfolioError: string | null = "Portfolio valuation requires reconciled account telemetry";
    let accountError: string | null = accountEnvironment === "unconfigured"
      ? "Delta credentials are not configured"
      : "Account data has not been loaded";
    let positions: DashboardPosition[] = [];
    let orders: DashboardOrder[] = [];
    if (accountEnvironment !== "unconfigured") {
      try {
        const snapshot = await services.delta.getAccountRiskSnapshot();
        const protection = await agent?.verifiedPositionProtection(snapshot);
        account = {
          ...account,
          equity: snapshot.equity,
          availableMargin: snapshot.availableMargin,
          marginUsed: snapshot.marginUsed,
          unrealizedPnl: snapshot.unrealizedPnl,
          realizedPnl: snapshot.realizedPnl,
          leverage: snapshot.positions[0]?.leverage ?? "",
          drawdownPercent: (() => {
            const dailyPnl = new Decimal(snapshot.realizedPnl).plus(snapshot.unrealizedPnl);
            const dailyLossCap = Decimal.min(services.config.maxDailyLoss, state.maxDailyLoss);
            return dailyPnl.lt(0)
              ? Decimal.min(dailyPnl.abs().div(dailyLossCap).mul(100), 100).toString()
              : "0";
          })()
        };
        accountStatus = "available";
        accountError = null;
        const rate = services.delta.getUsdInrRate();
        account.usdInrRate = rate;
        account.equityInr = new Decimal(snapshot.equity).mul(rate).toDecimalPlaces(2).toString();
        account.availableMarginInr = new Decimal(snapshot.availableMargin).mul(rate).toDecimalPlaces(2).toString();
        positions = snapshot.positions.map((position) => ({
          id: position.id,
          symbol: position.symbol,
          side: position.side === "buy" ? "long" as const : "short" as const,
          quantity: position.quantity,
          entryPrice: position.entryPrice,
          markPrice: position.markPrice,
          unrealizedPnl: position.unrealizedPnl,
          leverage: position.leverage,
          stopPrice: protection?.productId === position.productId ? protection.stopPrice : position.stopPrice,
          takeProfitPrice: protection?.productId === position.productId ? protection.takeProfitPrice : position.takeProfitPrice
        }));
        orders = snapshot.openOrders.map((order) => ({
          id: order.id,
          symbol: order.symbol,
          side: order.side,
          type: order.orderType,
          quantity: order.quantity,
          limitPrice: order.limitPrice,
          stopOrderType: order.stopOrderType,
          triggerPrice: order.triggerPrice,
          status: order.status,
          createdAt: order.createdAt
        }));
      } catch (error) {
        accountStatus = "unavailable";
        positions = [];
        orders = [];
        accountError = error instanceof DeltaApiError ? error.message : "Delta account data is unavailable";
      }
    }
    if (accountStatus === "available") {
      try {
        portfolio = await services.delta.getPortfolioValuation();
        portfolioError = null;
      } catch (error) {
        portfolioError = error instanceof DeltaApiError ? error.message : "Delta portfolio valuation is unavailable";
      }
    }
    response.json({
      market: {
        symbol: "BTCUSD",
        markPrice: latestPrice ?? "",
        fundingRate: fundingRate ?? "",
        websocketStatus: websocketStatus ?? "disconnected"
      },
      environment: services.config.deltaEnvironment,
      accountEnvironment,
      executionConfigured: testnetExecutionConfigured(services),
      bot: {
        enabled: state.enabled,
        killSwitch: state.killSwitch,
        riskStatus: services.status.get("risk_status") ?? "unknown",
        riskHaltReason: services.status.get("risk_halt_reason") ?? ""
      },
      account,
      accountStatus,
      accountError,
      portfolio,
      portfolioError,
      positions,
      orders,
      audit: services.aiAudit.recent(20).map((audit) => ({
        id: String(audit.id),
        occurredAt: new Date(audit.createdAt).toISOString(),
        decision: audit.decision,
        reason: audit.reason,
        riskApproved: false,
        validated: audit.accepted
      })),
      trades: recentTrades.map((trade) => ({
        id: String(trade.id),
        occurredAt: new Date(trade.createdAt).toISOString(),
        timestamp: Math.floor(trade.createdAt / 1000),
        side: trade.side,
        price: trade.price,
        quantity: trade.quantity,
        realizedPnl: trade.pnl ?? ""
      })),
      strategy: asStrategyConfig(state)
    });
  });

  app.get("/api/signal/preview", async (_request, response) => {
    try {
      const preview = getSignalPreview(services);
      response.json({ strategy: preview.strategy, signal: preview.signal });
    } catch (error) {
      response.status(503).json({
        message: error instanceof Error ? error.message : "Signal preview is unavailable",
        error: {
          code: "SIGNAL_PREVIEW_UNAVAILABLE",
          message: error instanceof Error ? error.message : "Signal preview is unavailable"
        }
      });
    }
  });

  app.get("/api/candles", (request, response) => {
    const timeframe = request.query.tf;
    if (typeof timeframe !== "string" || !CHART_TIMEFRAMES.includes(timeframe as ChartTimeframe)) {
      response.status(400).json({ error: { code: "INVALID_TIMEFRAME", message: `tf must be one of ${CHART_TIMEFRAMES.join(", ")}` } });
      return;
    }
    const limit = Number(request.query.limit ?? 500);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      response.status(400).json({ message: "limit must be an integer from 1 to 1000", error: { code: "INVALID_LIMIT", message: "limit must be an integer from 1 to 1000" } });
      return;
    }
    response.json({
      timeframe,
      candles: services.candles.list(timeframe as ChartTimeframe, limit).map((candle) => ({
        time: Math.floor(candle.timestamp / 1000),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume
      }))
    });
  });

  app.get("/api/account", async (_request, response, next) => {
    try {
      const [balances, positions] = await Promise.all([services.delta.getBalances(), services.delta.getPositions()]);
      response.json({ balances, positions });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/strategy", async (request, response) => {
    if (agent) { response.status(410).json({ message: "Strategy editing has been replaced by the Demo agent chat" }); return; }
    const configResult = StrategyConfigSchema.safeParse(request.body);
    if (configResult.success) {
      const current = services.botState.get();
      const strategy = resolveStrategyName(configResult.data.name);
      if (!strategy) {
        response.status(400).json({ message: "Unsupported strategy name", error: { code: "INVALID_STRATEGY", message: "Unsupported strategy name" } });
        return;
      }
      const parameters = configResult.data.parameters;
      let maxLeverage: Decimal;
      let riskPerTrade: Decimal;
      let stopLoss: Decimal;
      try {
        maxLeverage = new Decimal(parameters.maxLeverage ?? current.maxLeverage);
        riskPerTrade = new Decimal(parameters.riskPerTrade ?? current.riskPerTrade);
        stopLoss = new Decimal(parameters.stopLoss ?? current.stopLossPercent);
      } catch {
        response.status(400).json({ message: "Risk parameters must be valid decimals", error: { code: "INVALID_RISK_CONFIG", message: "Risk parameters must be valid decimals" } });
        return;
      }
      if (
        Object.keys(parameters).some((key) => !["riskPerTrade", "maxLeverage", "stopLoss", "riskRewardRatio"].includes(key)) ||
        !maxLeverage.isFinite() || maxLeverage.lte(0) || maxLeverage.gt(Math.min(services.config.maxLeverage, MAX_LEVERAGE)) ||
        !riskPerTrade.isFinite() || riskPerTrade.lte(0) || riskPerTrade.gt(1) ||
        !stopLoss.isFinite() || stopLoss.lte(0) || stopLoss.gt(10)
      ) {
        response.status(400).json({ message: "Risk parameters exceed safe configured limits", error: { code: "INVALID_RISK_CONFIG", message: "Risk parameters exceed safe configured limits" } });
        return;
      }
      let riskRewardRatio: Decimal;
      try {
        riskRewardRatio = new Decimal(parameters.riskRewardRatio ?? current.riskRewardRatio);
      } catch {
        response.status(400).json({ message: "Risk/reward ratio must be a valid decimal", error: { code: "INVALID_RISK_CONFIG", message: "Risk/reward ratio must be a valid decimal" } });
        return;
      }
      if (!riskRewardRatio.isFinite() || riskRewardRatio.lte(0) || riskRewardRatio.gt(5)) {
        response.status(400).json({ message: "Risk/reward ratio must be greater than 0 and at most 5", error: { code: "INVALID_RISK_CONFIG", message: "Risk/reward ratio must be greater than 0 and at most 5" } });
        return;
      }
      services.botState.update({
        strategy,
        maxLeverage: maxLeverage.toNumber(),
        riskPerTrade: riskPerTrade.toString(),
        stopLossPercent: stopLoss.toString(),
        riskRewardRatio: riskRewardRatio.toString(),
        instruction: configResult.data.instruction
      });
      let reevaluation: Awaited<ReturnType<typeof forceAiReevaluation>> | { status: "unavailable"; reason: string };
      try {
        reevaluation = await forceAiReevaluation(services, "1h");
      } catch {
        reevaluation = { status: "unavailable", reason: "AI reevaluation could not complete; the submitted operator configuration remains active" };
      }
      response.json({ strategy: asStrategyConfig(services.botState.get()), bot: services.botState.get(), reevaluation });
      return;
    }
    const parsed = z.object({ strategy: StrategySchema }).safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ message: "Provide a supported strategy name", error: { code: "INVALID_STRATEGY", message: "Provide a supported strategy name" } });
      return;
    }
    services.botState.update({ strategy: parsed.data.strategy as StrategyName });
    let reevaluation: Awaited<ReturnType<typeof forceAiReevaluation>> | { status: "unavailable"; reason: string };
    try {
      reevaluation = await forceAiReevaluation(services, "1h");
    } catch {
      reevaluation = { status: "unavailable", reason: "AI reevaluation could not complete; the submitted operator configuration remains active" };
    }
    response.json({ strategy: asStrategyConfig(services.botState.get()), bot: services.botState.get(), reevaluation });
  });

  app.post("/api/bot/toggle", async (request, response) => {
    const parsed = z.object({ enabled: z.boolean().optional() }).strict().safeParse(request.body ?? {});
    if (!parsed.success) {
      response.status(400).json({ message: "Only the enabled state may be updated", error: { code: "INVALID_BOT_STATE", message: "Only the enabled state may be updated" } });
      return;
    }
    const current = services.botState.get();
    const enabled = parsed.data.enabled ?? !current.enabled;
    if (enabled && agent?.safetyActionInProgress) {
      response.status(409).json({ message: "Wait for the Demo close-all safety action before enabling automation" });
      return;
    }
    if (enabled && agent && (services.config.deltaEnvironment !== "testnet" || !agent.snapshot().configured)) {
      response.status(409).json({ message: "Start requires the Demo environment and configured NVIDIA API credentials" });
      return;
    }
    agent?.invalidate();
    const controlRevision = agent?.repository.settings().revision;
    if (enabled && !testnetExecutionConfigured(services)) {
      response.status(409).json({
        message: "Delta credentials and live-trading confirmation are required to enable automated trading",
        error: { code: "DEMO_NOT_CONFIGURED", message: "Delta credentials and live-trading confirmation are required to enable automated trading" }
      });
      return;
    }
    if (enabled && current.killSwitch) {
      response.status(409).json({ message: "Clear the kill switch before enabling the bot", error: { code: "KILL_SWITCH_ACTIVE", message: "Clear the kill switch before enabling the bot" } });
      return;
    }
    if (enabled) {
      try {
        const account = await services.delta.getAccountRiskSnapshot();
        const synced = syncDailyLossCap(services, account);
        if (services.risk.dailyLossBreached(synced, account.unrealizedPnl, account.realizedPnl)) {
          services.botState.update({ enabled: false, killSwitch: true });
          services.status.set("risk_status", "daily_loss_locked");
          services.status.set("risk_halt_reason", "UTC daily loss limit reached or could not be validated");
          response.status(409).json({
            message: "Daily-loss risk limit is active; automated trading remains locked",
            error: { code: "DAILY_LOSS_LOCKED", message: "Daily-loss risk limit is active; automated trading remains locked" }
          });
          return;
        }
      } catch {
        response.status(503).json({
          message: "Account PnL could not be reconciled; automated trading remains paused",
          error: { code: "DEMO_RECONCILIATION_UNAVAILABLE", message: "Account PnL could not be reconciled; automated trading remains paused" }
        });
        return;
      }
    }
    if (enabled && (services.botState.get().killSwitch ||
        (agent && controlRevision !== agent.repository.settings().revision))) {
      response.status(409).json({ message: "Controls changed while checking readiness; automation was not enabled" });
      return;
    }
    const state = services.botState.update({ enabled });
    agent?.repository.event("activity", enabled ? "Operator enabled Demo automation." : "Operator paused automation. Exchange protection remains in place.");
    response.json({ enabled: state.enabled, bot: state });
  });

  app.post("/api/kill-switch", async (request, response) => {
    const parsed = z.object({ active: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!parsed.success) {
      response.status(400).json({ message: "active must be boolean", error: { code: "INVALID_KILL_SWITCH", message: "active must be boolean" } });
      return;
    }
    const active = parsed.data.active ?? true;
    if (agent?.safetyActionInProgress) {
      response.status(409).json({ message: "Demo close-all is in progress; the risk lock cannot be changed and duplicate safety actions are refused" });
      return;
    }
    agent?.invalidate();
    const bot = services.botState.update({ killSwitch: active, ...(active ? { enabled: false } : {}) });
    agent?.repository.event("activity", active ? "Operator engaged the kill switch." : "Operator manually cleared the risk lock.");
    if (!active) {
      response.json({
        accepted: true,
        exchangeActions: { status: "not_attempted", reason: "Manual risk-lock reset only; no exchange action was requested" },
        bot
      });
      return;
    }
    if (!testnetExecutionConfigured(services)) {
      response.status(503).json({
        accepted: true,
        exchangeActions: { status: "unavailable", reason: "Delta credentials and live-trading confirmation are required for exchange safety actions" },
        bot
      });
      return;
    }
    const approval = services.risk.approveEmergencyClose(bot, services.config.deltaProductId);
    if (!approval) {
      response.status(409).json({
        accepted: true,
        exchangeActions: { status: "unavailable", reason: "Risk core refused emergency exchange actions" },
        bot
      });
      return;
    }
    try {
      const actions = await services.execution.emergencyHalt(approval, bot);
      const succeeded = actions.cancelOrders === "succeeded" && actions.closePositions === "succeeded";
      response.status(succeeded ? 200 : 503).json({
        accepted: true,
        exchangeActions: {
          status: succeeded ? "succeeded" : "partial",
          ...actions,
          ...(succeeded ? {} : { reason: "One or more exchange safety actions did not confirm" })
        },
        bot
      });
    } catch {
      response.status(503).json({
        accepted: true,
        exchangeActions: { status: "failed", reason: "Exchange safety actions failed; local trading remains locked" },
        bot
      });
    }
  });

  app.post("/api/ai/decision", async (request, response) => {
    if (agent) { response.status(410).json({ message: "Use the Demo agent chat for AI analysis" }); return; }
    const parsed = z.object({ timeframe: z.enum(TIMEFRAMES).default("1h") }).safeParse(request.body ?? {});
    if (!parsed.success) {
      response.status(400).json({ message: "Unsupported timeframe", error: { code: "INVALID_TIMEFRAME", message: "Unsupported timeframe" } });
      return;
    }
    try {
      response.json(await forceAiReevaluation(services, parsed.data.timeframe));
    } catch {
      response.status(503).json({
        message: "AI reevaluation is unavailable; no recommendation was applied",
        error: { code: "AI_REEVALUATION_UNAVAILABLE", message: "AI reevaluation is unavailable; no recommendation was applied" }
      });
    }
  });

  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof DeltaApiError) {
      response.status(error.status >= 400 && error.status < 600 ? error.status : 502)
        .json({ message: error.message, error: { code: "EXCHANGE_ERROR", message: error.message } });
      return;
    }
    response.status(500).json({ message: "The request could not be completed safely", error: { code: "INTERNAL_ERROR", message: "The request could not be completed safely" } });
  };
  app.use(errorHandler);
  return app;
}
