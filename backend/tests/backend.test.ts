import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import OpenAI from "openai";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { DeltaApiError, DeltaIndiaClient, deltaIndiaEndpoints } from "../src/exchange/delta-client.js";
import { DeltaMarketStream } from "../src/exchange/market-stream.js";
import { LiveCandleHub, parseWorkerCandleMessage, toLiveCandleEvent } from "../src/live/live-candle-hub.js";
import WebSocket from "ws";
import { createDatabase } from "../src/persistence/database.js";
import {
  SqliteAiAuditRepository, SqliteBotStateRepository, SqliteCandleRepository,
  SqliteServiceStatusRepository, SqliteTradeRepository
} from "../src/persistence/repositories.js";
import {
  consumeEmergencyCloseApproval, consumeRiskApproval, hasConsumedRiskApproval, RiskCore
} from "../src/risk-core/risk-core.js";
import { ExecutionService } from "../src/execution/execution-service.js";
import { DeltaIndiaTestnetOrderGateway } from "../src/execution/delta-order-gateway.js";
import { evaluateStrategy, rebaseSignal } from "../src/strategy/strategy.js";
import { AiDecisionService } from "../src/ai/decision-service.js";
import { applyAiDecision } from "../src/ai/apply-decision.js";
import type { Candle } from "../src/domain.js";
import { syncDailyLossCap, type AppServices } from "../src/services.js";

const servers: Server[] = [];
const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
});

function testSystem(): AppServices & { orderGateway: { placeOrder: () => Promise<{ accepted: boolean }> } } {
  const db = createDatabase(":memory:");
  const botState = new SqliteBotStateRepository(db);
  const candles = new SqliteCandleRepository(db);
  const trades = new SqliteTradeRepository(db);
  const aiAudit = new SqliteAiAuditRepository(db);
  const status = new SqliteServiceStatusRepository(db);
  const config = {
    port: 4000, databasePath: ":memory:",
    deltaApiKey: "", deltaApiSecret: "", deltaProductId: 27, maxLeverage: 2, maxDailyLoss: "1000",
    dailyLossPercent: "2", deltaEnvironment: "testnet" as const, liveTradingConfirmed: false,
    nimApiKey: "", nimBaseUrl: "https://integrate.api.nvidia.com/v1",
    aiModel: "test-model"
  };
  const delta = new DeltaIndiaClient({ apiKey: "", apiSecret: "", productId: 27 });
  const risk = new RiskCore("1000", 2);
  const orderGateway = { placeOrder: async () => ({ accepted: true }) };
  const execution = new ExecutionService(trades, orderGateway, config);
  const ai = {
    advise: async (context: { currentStrategy: string }) => ({
      strategy: context.currentStrategy as "meanReversion" | "trendBreakout" | "gridScalper" | "flat",
      parameters: { maxLeverage: "1", riskPerTrade: "0.25", stopLoss: "0.5", riskRewardRatio: "1.5" },
      reasoning: "Conservative test recommendation"
    })
  };
  return {
    db, botState, candles, trades, aiAudit, status, config, delta, orderGateway, risk, execution, ai
  } as unknown as AppServices & { orderGateway: typeof orderGateway };
}

function trackDb<T extends AppServices>(services: T): T {
  databases.push(services.db);
  return services;
}

function approveWithDemoPnl(
  services: AppServices,
  signal: Parameters<AppServices["risk"]["approve"]>[0],
  state: Parameters<AppServices["risk"]["approve"]>[1],
  productId: number,
  requestedLeverage = 1,
  unrealizedPnl = "0",
  realizedPnl = "0"
) {
  const risk = services.risk;
  return risk.approve(signal, state, productId, requestedLeverage, unrealizedPnl, realizedPnl);
}

function validSignal(side: "buy" | "sell" = "buy") {
  return {
    strategy: "meanReversion" as const, side, referencePrice: "100",
    stopPrice: side === "buy" ? "99" : "101", confidence: 0.9, reason: "test"
  };
}

function candlesFrom(values: number[]): Candle[] {
  return values.map((value, index) => ({
    timestamp: index * 3_600_000,
    open: String(value),
    high: String(value + 1),
    low: String(value - 1),
    close: String(value),
    volume: "1"
  }));
}

function freshCandlesFrom(values: number[]): Candle[] {
  const now = Date.now();
  return values.map((value, index) => ({
    timestamp: now - (values.length - index - 1) * 3_600_000,
    open: String(value),
    high: String(value + 1),
    low: String(value - 1),
    close: String(value),
    volume: "1"
  }));
}

function start(app: ReturnType<typeof createApp>): Promise<string> {
  return new Promise((resolve) => {
    const server = createServer(app);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

describe("backend safety and API", () => {
  it("passes exchange order purpose and trigger prices through the dashboard without relabeling status", async () => {
    const services = trackDb(testSystem());
    services.config = { ...services.config, deltaApiKey: "test", deltaApiSecret: "test" };
    vi.spyOn(services.delta, "getAccountRiskSnapshot").mockResolvedValue({
      equity: "198", availableMargin: "130", marginUsed: "64", unrealizedPnl: "0", realizedPnl: "0", positions: [],
      openOrders: [
        { id: "stop", productId: 27, symbol: "BTCUSD", side: "buy", orderType: "market_order", quantity: "1",
          stopOrderType: "stop_loss_order", triggerPrice: "64463.8", limitPrice: null, status: "pending", createdAt: "" },
        { id: "target", productId: 27, symbol: "BTCUSD", side: "buy", orderType: "market_order", quantity: "1",
          stopOrderType: "take_profit_order", triggerPrice: "62549.1", limitPrice: null, status: "pending", createdAt: "" }
      ]
    });
    vi.spyOn(services.delta, "getPortfolioValuation").mockResolvedValue({ totalUsd: "198", totalInr: "16830", holdings: [] });
    const url = await start(createApp(services));
    const result = await (await fetch(`${url}/api/dashboard`)).json();
    expect(result).toMatchObject({ accountStatus: "available", orders: [
      { id: "stop", stopOrderType: "stop_loss_order", triggerPrice: "64463.8", status: "pending", type: "market_order" },
      { id: "target", stopOrderType: "take_profit_order", triggerPrice: "62549.1", status: "pending", type: "market_order" }
    ] });
  });
  it("uses environment-specific BTCUSD products and ignores legacy environment selectors", () => {
    const config = loadConfig({});
    expect(config.port).toBe(4000);
    expect(config.databasePath).toBe("/app/data/bot.sqlite");
    expect(config.aiModel).toBe("nvidia/nemotron-3.5-bolt-e4b");
    expect(config.deltaProductId).toBe(84);
    expect(loadConfig({ DELTA_ENV: "production" }).deltaProductId).toBe(27);
    expect(loadConfig({ DELTA_ENV: "testnet", DELTA_PRODUCT_ID: "" }).deltaProductId).toBe(84);
    expect(loadConfig({ DELTA_ENV: "production", DELTA_PRODUCT_ID: "84" }).deltaProductId).toBe(84);
    expect(loadConfig({
      TRADING_MODE: "live",
      DELTA_ENV: "production",
      DELTA_TESTNET: "false"
    })).toMatchObject({
      port: 4000,
      databasePath: "/app/data/bot.sqlite"
    });
    expect(loadConfig({ NVIDIA_API_KEY: "nim-key" })).toMatchObject({
      nimApiKey: "nim-key"
    });
    expect(() => loadConfig({ MAX_DAILY_LOSS: "-1" })).toThrow("positive decimal");
  });

  it("selects only the credentials for the configured Delta environment", () => {
    const shared = {
      DELTA_API_KEY: "legacy-key",
      DELTA_API_SECRET: "legacy-secret",
      DELTA_DEMO_API_KEY: "demo-key",
      DELTA_DEMO_API_SECRET: "demo-secret",
      DELTA_LIVE_API_KEY: "live-key",
      DELTA_LIVE_API_SECRET: "live-secret"
    };

    expect(loadConfig({ ...shared, DELTA_ENV: "testnet" })).toMatchObject({
      deltaEnvironment: "testnet",
      deltaApiKey: "demo-key",
      deltaApiSecret: "demo-secret",
      deltaProductId: 84
    });
    expect(loadConfig({ ...shared, DELTA_ENV: "production" })).toMatchObject({
      deltaEnvironment: "production",
      deltaApiKey: "live-key",
      deltaApiSecret: "live-secret",
      deltaProductId: 27
    });
    expect(loadConfig({
      DELTA_ENV: "testnet",
      DELTA_API_KEY: "legacy-key",
      DELTA_API_SECRET: "legacy-secret",
      DELTA_LIVE_API_KEY: "live-key",
      DELTA_LIVE_API_SECRET: "live-secret"
    })).toMatchObject({ deltaApiKey: "", deltaApiSecret: "" });
    expect(loadConfig({
      DELTA_ENV: "testnet",
      DELTA_API_KEY: "legacy-key",
      DELTA_API_SECRET: "legacy-secret"
    })).toMatchObject({ deltaApiKey: "legacy-key", deltaApiSecret: "legacy-secret" });
  });

  it("serves /api/health and rejects unsupported candle timeframes", async () => {
    const services = trackDb(testSystem());
    const base = await start(createApp(services));
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", database: "ok" });
    const candles = await fetch(`${base}/api/candles?tf=3m`);
    expect(candles.status).toBe(400);
    expect((await (await fetch(`${base}/api/dashboard`)).json()).strategy.name).toBe("flat");
    const invalidLimit = await fetch(`${base}/api/candles?tf=1h&limit=1001`);
    expect(invalidLimit.status).toBe(400);
    services.candles.upsert("1h", freshCandlesFrom(Array.from({ length: 30 }, (_, index) => 100 + index)));
    const strategy = await fetch(`${base}/api/strategy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Trend following",
        parameters: { riskPerTrade: "0.5", maxLeverage: "2", stopLoss: "1.5" },
        instruction: "Avoid volatile entries."
      })
    });
    expect(strategy.status).toBe(200);
    expect(await strategy.json()).toMatchObject({
      strategy: { name: "trendBreakout", parameters: {
        maxLeverage: "1", riskPerTrade: "0.25", stopLoss: "0.5", riskRewardRatio: "1.5"
      } },
      reevaluation: { status: "applied", applied: true }
    });
    const invalidStrategy = await fetch(`${base}/api/strategy`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "untrusted strategy", parameters: {}, instruction: "" })
    });
    expect(invalidStrategy.status).toBe(400);
    const invalidRisk = await fetch(`${base}/api/strategy`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "flat", parameters: { maxLeverage: "100" }, instruction: "" })
    });
    expect(invalidRisk.status).toBe(400);
    const candleResponse = await fetch(`${base}/api/candles?tf=1h&limit=2`);
    expect((await candleResponse.json()).candles).toHaveLength(2);
    const aiResponse = await fetch(`${base}/api/ai/decision`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeframe: "1h" })
    });
    expect(await aiResponse.json()).toMatchObject({
      applied: true,
      decision: { strategy: "trendBreakout", parameters: { riskRewardRatio: "1.5" } },
      strategy: { name: "trendBreakout" }
    });
    services.aiAudit.record({
      model: "test-model", promptHash: "a".repeat(64),
      decision: JSON.stringify({ strategy: "flat", reasoning: "No trade" }),
      accepted: true, rejectionReason: null
    });
    const auditDashboard = await (await fetch(`${base}/api/dashboard`)).json();
    expect(auditDashboard.audit[0]).toMatchObject({ riskApproved: false, validated: true });
    const account = await fetch(`${base}/api/account`);
    expect(account.status).toBe(503);
    expect(await account.json()).toMatchObject({ message: "Delta API credentials are not configured" });
    const botResponse = await fetch(`${base}/api/bot/toggle`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true })
    });
    expect(botResponse.status).toBe(409);
    expect(await botResponse.json()).toMatchObject({ error: { code: "DEMO_NOT_CONFIGURED" } });
    const invalidMode = await fetch(`${base}/api/bot/toggle`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, mode: "live" })
    });
    expect(invalidMode.status).toBe(400);
    services.config = {
      ...services.config,
      deltaApiKey: "test-key",
      deltaApiSecret: "test-secret"
    };
    vi.spyOn(services.delta, "getAccountRiskSnapshot").mockResolvedValue({
      equity: "1000", availableMargin: "1000", marginUsed: "0", unrealizedPnl: "0", realizedPnl: "0",
      positions: [], openOrders: []
    });
    const enableDemo = await fetch(`${base}/api/bot/toggle`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true })
    });
    expect(enableDemo.status).toBe(200);
    expect(await enableDemo.json()).toMatchObject({ enabled: true });
    const kill = await fetch(`${base}/api/kill-switch`, { method: "POST" });
    expect(await kill.json()).toMatchObject({
      accepted: true,
      exchangeActions: { status: "failed" }
    });
    const reenable = await fetch(`${base}/api/bot/toggle`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true })
    });
    expect(reenable.status).toBe(409);
    const reset = await fetch(`${base}/api/kill-switch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ active: false })
    });
    expect((await reset.json()).bot.killSwitch).toBe(false);
    const enableAfterReset = await fetch(`${base}/api/bot/toggle`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true })
    });
    expect(enableAfterReset.status).toBe(200);
    const removedConfirmation = await fetch(`${base}/api/demo/confirm`, { method: "POST" });
    expect(removedConfirmation.status).toBe(404);
    const removedLocalClose = await fetch(`${base}/api/positions/1/close`, { method: "POST" });
    expect(removedLocalClose.status).toBe(404);
  });

  it("loads account telemetry from the Demo connection", async () => {
    const services = trackDb(testSystem());
    vi.spyOn(services.delta, "getPortfolioValuation").mockResolvedValue({
      totalUsd: "2502", totalInr: "212670",
      holdings: [
        { asset: "USD", quantity: "2500", valueUsd: "2500", valueInr: "212500" },
        { asset: "BTC", quantity: "0.00002", valueUsd: "2", valueInr: "170" }
      ]
    });
    services.config = {
      ...services.config,
      deltaApiKey: "demo-key",
      deltaApiSecret: "demo-secret"
    };
    vi.spyOn(services.delta, "getAccountRiskSnapshot").mockResolvedValue({
      equity: "2500",
      availableMargin: "2200",
      marginUsed: "300",
      unrealizedPnl: "12",
      realizedPnl: "4.5",
      positions: [],
      openOrders: []
    });
    const base = await start(createApp(services));

    const response = await fetch(`${base}/api/dashboard`);
    const dashboard = await response.json();

    expect(dashboard).toMatchObject({
      environment: "testnet",
      accountEnvironment: "demo",
      accountStatus: "available",
      accountError: null,
      portfolio: { totalUsd: "2502", totalInr: "212670" },
      portfolioError: null,
      account: {
        equity: "2500",
        availableMargin: "2200",
        marginUsed: "300",
        unrealizedPnl: "12",
        realizedPnl: "4.5",
        usdInrRate: "85",
        equityInr: "212500",
        availableMarginInr: "187000"
      }
    });
  });

  it("verifies live account telemetry without authorizing live execution", async () => {
    const services = trackDb(testSystem());
    vi.spyOn(services.delta, "getPortfolioValuation").mockRejectedValue(new Error("ticker unavailable"));
    services.config = {
      ...services.config, deltaEnvironment: "production",
      deltaApiKey: "test-key", deltaApiSecret: "test-secret", liveTradingConfirmed: false
    };
    vi.spyOn(services.delta, "getAccountRiskSnapshot").mockResolvedValue({
      equity: "8.68129412", availableMargin: "8.68129412", marginUsed: "0",
      unrealizedPnl: "0", realizedPnl: "0", positions: [], openOrders: []
    });
    const placeOrder = vi.spyOn(services.orderGateway, "placeOrder");
    const base = await start(createApp(services));
    const response = await fetch(`${base}/api/dashboard`);
    expect(await response.json()).toMatchObject({
      environment: "production", accountEnvironment: "live", accountStatus: "available",
      executionConfigured: false, bot: { enabled: false },
      portfolio: null, portfolioError: "Delta portfolio valuation is unavailable",
      account: { equityInr: "737.91" }
    });
    const toggle = await fetch(`${base}/api/bot/toggle`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });
    expect(toggle.ok).toBe(false);
    expect(services.botState.get().enabled).toBe(false);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("does not claim verified live telemetry when authentication fails", async () => {
    const services = trackDb(testSystem());
    services.config = {
      ...services.config, deltaEnvironment: "production",
      deltaApiKey: "test-key", deltaApiSecret: "test-secret"
    };
    vi.spyOn(services.delta, "getAccountRiskSnapshot").mockRejectedValue(new Error("authentication failed"));
    const base = await start(createApp(services));
    const response = await fetch(`${base}/api/dashboard`);
    expect(await response.json()).toMatchObject({
      environment: "production", accountEnvironment: "live", accountStatus: "unavailable",
      executionConfigured: false, account: { equity: "", equityInr: "" }
    });
  });

  it("keeps automated Demo trading locked when exchange daily PnL breaches the loss cap", async () => {
    const services = trackDb(testSystem());
    services.config = {
      ...services.config,
      deltaApiKey: "demo-key",
      deltaApiSecret: "demo-secret"
    };
    vi.spyOn(services.delta, "getAccountRiskSnapshot").mockResolvedValue({
      equity: "0",
      availableMargin: "0",
      marginUsed: "0",
      unrealizedPnl: "0",
      realizedPnl: "-1000",
      positions: [],
      openOrders: []
    });
    const base = await start(createApp(services));

    const response = await fetch(`${base}/api/bot/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true })
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "DAILY_LOSS_LOCKED" }
    });
    expect(services.botState.get()).toMatchObject({ enabled: false, killSwitch: true });
  });

  it("previews only a fresh closed-candle strategy signal and never authorizes execution", async () => {
    const services = trackDb(testSystem());
    services.candles.upsert("1h", freshCandlesFrom(Array.from({ length: 30 }, (_, index) => 100 + index)));
    services.status.set("market_price", "130");
    const base = await start(createApp(services));

    const response = await fetch(`${base}/api/signal/preview`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      strategy: "flat",
      signal: {
        strategy: "flat",
        side: null,
        referencePrice: "130",
        stopPrice: null
      }
    });
  });

  it("approves only bounded Demo orders and consumes approval once", async () => {
    const services = trackDb(testSystem());
    services.config = { ...services.config, deltaApiKey: "demo-key", deltaApiSecret: "demo-secret" };
    services.execution = new ExecutionService(services.trades, services.orderGateway, services.config);
    const state = services.botState.update({ enabled: true });
    const signal = validSignal();
    const result = approveWithDemoPnl(services, signal, state, 27, 4);
    expect(result).toMatchObject({ approved: false });
    const decision = approveWithDemoPnl(services, signal, state, 27, 2);
    expect(decision.approved).toBe(true);
    if (!decision.approved) return;
    const placed = await services.execution.execute(decision.approval, state);
    expect(placed.status).toBe("submitted");
    await expect(services.execution.execute(decision.approval, state))
      .rejects.toThrow("fresh RiskApproval");
    expect(services.trades.recent(1)[0]).toMatchObject({ status: "submitted" });
  });

  it("uses UTC daily loss, stop direction, leverage, and persisted risk limits", () => {
    const services = trackDb(testSystem());
    const enabled = services.botState.update({ enabled: true });
    expect(approveWithDemoPnl(services, validSignal(), { ...enabled, enabled: false }, 27).approved).toBe(false);
    expect(approveWithDemoPnl(services, validSignal(), { ...enabled, killSwitch: true }, 27).approved).toBe(false);
    expect(approveWithDemoPnl(services, { ...validSignal(), side: null }, enabled, 27).approved).toBe(false);
    expect(approveWithDemoPnl(services, validSignal(), enabled, 27, 4)).toMatchObject({ approved: false });
    expect(approveWithDemoPnl(services, { ...validSignal(), stopPrice: "100" }, enabled, 27).approved).toBe(false);
    expect(approveWithDemoPnl(services, validSignal(), enabled, 27))
      .toMatchObject({ approved: true, approval: { stopPrice: "99", takeProfitPrice: "102" } });
    expect(approveWithDemoPnl(services, validSignal("sell"), enabled, 27))
      .toMatchObject({ approved: true, approval: { stopPrice: "101", takeProfitPrice: "98" } });
    expect(approveWithDemoPnl(services, validSignal(), { ...enabled, riskRewardRatio: "3" }, 27))
      .toMatchObject({ approved: true, approval: { takeProfitPrice: "103" } });
    expect(approveWithDemoPnl(services, validSignal(), { ...enabled, riskPerTrade: "2" }, 27))
      .toMatchObject({ approved: false, reason: "Persisted risk limits are invalid" });
    expect(approveWithDemoPnl(services, validSignal(), { ...enabled, maxDailyLoss: "0" }, 27))
      .toMatchObject({ approved: false, reason: "Persisted risk limits are invalid" });
    expect(approveWithDemoPnl(services, { ...validSignal(), referencePrice: "NaN" }, enabled, 27).approved).toBe(false);
    const microscopic = approveWithDemoPnl(services, {
      ...validSignal(), referencePrice: "1e100", stopPrice: "9.9e99"
    }, enabled, 27);
    expect(microscopic).toMatchObject({ approved: false, reason: "Calculated quantity is below supported precision" });
    expect(approveWithDemoPnl(services, validSignal(), enabled, 27, 1, "0", "-1000"))
      .toMatchObject({ approved: false, reason: "UTC daily-loss circuit breaker is active" });
  });

  it("rejects forged and expired RiskApproval values", () => {
    expect(consumeRiskApproval({ approvalId: "fake", issuedAt: Date.now() } as never)).toBe(false);
    const services = trackDb(testSystem());
    const state = services.botState.update({ enabled: true });
    const decision = approveWithDemoPnl(services, validSignal(), state, 27);
    expect(decision.approved).toBe(true);
    if (!decision.approved) return;
    vi.useFakeTimers();
    vi.setSystemTime(decision.approval.issuedAt);
    expect(consumeRiskApproval(decision.approval)).toBe(true);
    expect(hasConsumedRiskApproval(decision.approval)).toBe(true);
    vi.advanceTimersByTime(30_001);
    expect(hasConsumedRiskApproval(decision.approval)).toBe(false);
  });

  it("fails closed on forged approval and inactive bot state in execution", async () => {
    const services = trackDb(testSystem());
    const state = services.botState.get();
    await expect(services.execution.execute(
      { approvalId: "forged", issuedAt: Date.now(), quantity: "invalid", entryPrice: "100" } as never, state
    )).rejects.toThrow("approved order values are invalid");
    await expect(services.execution.execute(undefined as never, state))
      .rejects.toThrow("approved quantity is invalid");
    await expect(services.execution.execute({
      approvalId: "forged", issuedAt: Date.now(), quantity: "1", entryPrice: "100",
      side: "buy", takeProfitPrice: "99"
    } as never, state)).rejects.toThrow("approved order values are invalid");
    await expect(services.execution.execute(
      { approvalId: "forged", issuedAt: Date.now(), quantity: "1", entryPrice: "100", takeProfitPrice: "102" } as never, state
    )).rejects.toThrow("fresh RiskApproval");
    const enabledState = services.botState.update({ enabled: true });
    const decision = approveWithDemoPnl(services, validSignal(), enabledState, 27);
    expect(decision.approved).toBe(true);
    if (!decision.approved) return;
    await expect(services.execution.execute(decision.approval, { ...enabledState, enabled: false }))
      .rejects.toThrow("bot is disabled");
    const open = services.trades.record({
      productId: 27, side: "buy", status: "submitting", quantity: "1",
      price: "100", stopPrice: "99", clientOrderId: "already-open"
    });
    const second = approveWithDemoPnl(services, validSignal("sell"), enabledState, 27);
    expect(second.approved).toBe(true);
    if (!second.approved) return;
    await expect(services.execution.execute(second.approval, enabledState))
      .rejects.toThrow("unresolved order submission");
    expect(open).toBeGreaterThan(0);
  });

  it("rejects approvals for mismatched products and configured leverage caps", async () => {
    const services = trackDb(testSystem());
    const state = services.botState.update({ enabled: true });
    const productApproval = approveWithDemoPnl(services, validSignal(), state, 27);
    expect(productApproval.approved).toBe(true);
    if (!productApproval.approved) return;
    const wrongProduct = new ExecutionService(services.trades, services.orderGateway, {
      ...services.config, deltaProductId: 28
    });
    await expect(wrongProduct.execute(productApproval.approval, state))
      .rejects.toThrow("does not match configured product");

    const leverageApproval = approveWithDemoPnl(services, validSignal(), state, 27);
    expect(leverageApproval.approved).toBe(true);
    if (!leverageApproval.approved) return;
    const lowCap = new ExecutionService(services.trades, services.orderGateway, {
      ...services.config, maxLeverage: 0.5
    });
    await expect(lowCap.execute(leverageApproval.approval, state))
      .rejects.toThrow("approved leverage exceeds configured limits");
  });

  it("submits a testnet order only behind all gates and records it as pending", async () => {
    const services = trackDb(testSystem());
    const placeOrder = vi.fn(async () => ({ id: "testnet-order" }));
    (services as unknown as { orderGateway: { placeOrder: typeof placeOrder } }).orderGateway = { placeOrder };
    const state = services.botState.update({ enabled: true });
    const decision = approveWithDemoPnl(services, validSignal(), state, 27);
    expect(decision.approved).toBe(true);
    if (!decision.approved) return;
    await expect(services.execution.execute(decision.approval, state))
      .rejects.toThrow("Delta credentials are required");
    expect(placeOrder).not.toHaveBeenCalled();

    const testnetConfig = {
      ...services.config,
      deltaApiKey: "test-key",
      deltaApiSecret: "test-secret"
    };
    const execution = new ExecutionService(services.trades, { placeOrder }, testnetConfig);
    const next = approveWithDemoPnl(services, validSignal(), state, 27);
    expect(next.approved).toBe(true);
    if (!next.approved) return;
    const result = await execution.execute(next.approval, state);
    expect(result.status).toBe("submitted");
    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      productId: 27, side: "buy", quantity: expect.any(String), stopPrice: "99", takeProfitPrice: "102",
      clientOrderId: expect.stringMatching(/^[a-f0-9]{32}$/)
    }), expect.objectContaining({ approvalId: next.approval.approvalId }));
    expect(services.trades.hasPendingSubmission(27)).toBe(false);
  });

  it("uses a one-use risk approval and verifies product-scoped kill-switch actions", async () => {
    const services = trackDb(testSystem());
    const requests: Array<{ url: string; method: string; body: string }> = [];
    let positionReads = 0;
    const gateway = new DeltaIndiaTestnetOrderGateway({
      apiKey: "test-key", apiSecret: "test-secret", productId: 84
    }, async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({
        url: String(input),
        method,
        body: String(init?.body ?? "")
      });
      if (url.pathname === "/v2/positions/margined") {
        positionReads += 1;
        return Response.json({
          success: true,
          result: positionReads === 1 ? [{ id: 8, product_id: 84, size: "-2" }] : []
        });
      }
      if (url.pathname === "/v2/orders" && method === "GET") {
        return Response.json({ success: true, result: [], meta: { after: null, before: null } });
      }
      return Response.json({ success: true, result: { ok: true } });
    });
    const testnetConfig = {
      ...services.config,
      deltaProductId: 84,
      deltaApiKey: "test-key",
      deltaApiSecret: "test-secret"
    };
    const execution = new ExecutionService(services.trades, gateway, testnetConfig);
    const bot = services.botState.update({ enabled: false, killSwitch: true });
    expect(services.risk.approveEmergencyClose({ ...bot, killSwitch: false }, 84)).toBeNull();
    const approval = services.risk.approveEmergencyClose(bot, 84);
    expect(approval).not.toBeNull();
    if (!approval) return;
    expect(consumeEmergencyCloseApproval(approval)).toBe(true);
    expect(consumeEmergencyCloseApproval(approval)).toBe(false);

    const freshApproval = services.risk.approveEmergencyClose(bot, 84);
    expect(freshApproval).not.toBeNull();
    if (!freshApproval) return;
    expect(await execution.emergencyHalt(freshApproval, bot)).toEqual({
      cancelOrders: "succeeded",
      closePositions: "succeeded"
    });
    const cancelRequest = requests.find(({ method, url }) => method === "DELETE" && new URL(url).pathname === "/v2/orders/all");
    expect(JSON.parse(cancelRequest?.body ?? "{}")).toEqual({
      product_id: 84,
      cancel_limit_orders: "true",
      cancel_stop_orders: "true",
      cancel_reduce_only_orders: "true"
    });
    const positionClose = requests.find(({ method, url }) => method === "POST" && new URL(url).pathname === "/v2/orders");
    expect(JSON.parse(positionClose?.body ?? "{}")).toMatchObject({
      product_id: 84, size: 2, side: "buy", order_type: "market_order", reduce_only: "true"
    });
    expect(requests.some(({ url }) => new URL(url).pathname === "/v2/positions/close_all")).toBe(false);
    expect(requests.filter(({ method, url }) => method === "GET" && new URL(url).pathname === "/v2/orders")).toHaveLength(2);
    expect(positionReads).toBe(2);
  });

  it("does not claim kill-switch completion when read-back shows positions remain", async () => {
    const services = trackDb(testSystem());
    const state = services.botState.update({ enabled: false, killSwitch: true });
    const gateway = {
      placeOrder: vi.fn(),
      cancelAllOrders: vi.fn(async () => undefined),
      closeAllPositions: vi.fn(async () => undefined),
      confirmNoOpenOrders: vi.fn(async () => true),
      confirmNoOpenPositions: vi.fn(async () => false)
    };
    const execution = new ExecutionService(services.trades, gateway, {
      ...services.config, deltaApiKey: "key", deltaApiSecret: "secret"
    });
    const approval = services.risk.approveEmergencyClose(state, 27);
    expect(approval).not.toBeNull();
    if (!approval) return;
    await expect(execution.emergencyHalt(approval, state)).resolves.toEqual({
      cancelOrders: "succeeded",
      closePositions: "failed"
    });
  });

  it("persists uncertain Demo submissions and never retries them automatically", async () => {
    const services = trackDb(testSystem());
    const state = services.botState.update({ enabled: true });
    const failure = vi.fn(async () => { throw new Error("transport timeout"); });
    const config = {
      ...services.config,
      deltaApiKey: "test-key",
      deltaApiSecret: "test-secret"
    };
    const execution = new ExecutionService(services.trades, { placeOrder: failure }, config);
    const first = approveWithDemoPnl(services, validSignal(), state, 27);
    expect(first.approved).toBe(true);
    if (!first.approved) return;
    await expect(execution.execute(first.approval, state)).rejects.toThrow("automatic retry is disabled");
    expect(services.trades.recent(1)[0]?.status).toBe("submission_unknown");
    expect(services.trades.hasPendingSubmission(27)).toBe(true);
    const retry = approveWithDemoPnl(services, validSignal(), state, 27);
    expect(retry.approved).toBe(true);
    if (!retry.approved) return;
    await expect(execution.execute(retry.approval, state)).rejects.toThrow("unresolved order submission");
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it("runs technical strategies and fails flat on insufficient or invalid market data", () => {
    expect(evaluateStrategy("flat", candlesFrom([100, 100])).side).toBeNull();
    expect(evaluateStrategy("trendBreakout", candlesFrom([100, 100])).side).toBeNull();
    const oversold = candlesFrom([...Array.from({ length: 30 }, () => 100), 50]);
    expect(evaluateStrategy("meanReversion", oversold).side).toBe("buy");
    const uptrend = candlesFrom(Array.from({ length: 40 }, (_, i) => 100 + i));
    const uptrendContext = { "1h": uptrend, "4h": uptrend, "1d": uptrend, "1w": uptrend };
    expect(evaluateStrategy("trendBreakout", uptrend).side).toBeNull();
    const trendSignal = evaluateStrategy("trendBreakout", uptrend, "1", uptrendContext);
    expect(trendSignal.side).toBe("buy");
    expect(Number(trendSignal.stopPrice)).toBeGreaterThan(100);
    expect(Number(trendSignal.stopPrice)).toBeLessThan(139);
    const gridCandles = candlesFrom([...Array.from({ length: 20 }, () => 100), 80]);
    expect(evaluateStrategy("gridScalper", gridCandles).side).toBe("buy");
    expect(evaluateStrategy("gridScalper", gridCandles, "11").side).toBeNull();
    const overbought = candlesFrom([...Array.from({ length: 30 }, () => 100), 150]);
    expect(evaluateStrategy("meanReversion", overbought).side).toBe("sell");
    const rebased = rebaseSignal(validSignal(), "110", "2");
    expect(rebased).toMatchObject({ referencePrice: "110", stopPrice: "107.8" });
    expect(rebaseSignal(validSignal(), "0", "2").side).toBeNull();
  });

  it("counts unrealized loss toward the UTC daily-loss lock and fails closed on invalid marks", () => {
    const services = trackDb(testSystem());
    const state = services.botState.get();
    expect(services.risk.dailyLossBreached(state, "-999.99", "0")).toBe(false);
    expect(services.risk.dailyLossBreached(state, "-1000", "0")).toBe(true);
    expect(services.risk.dailyLossBreached(state, "not-a-number", "0")).toBe(true);
    const enabled = services.botState.update({ enabled: true });
    expect(approveWithDemoPnl(services, validSignal(), enabled, 27, 1, "-1000"))
      .toEqual({ approved: false, reason: "UTC daily-loss circuit breaker is active" });
  });

  it("uses reconciled exchange realized PnL instead of local records when provided", () => {
    const services = trackDb(testSystem());
    const state = services.botState.update({ enabled: true });

    expect(services.risk.dailyLossBreached(state, "0", "-1000")).toBe(true);
    expect(approveWithDemoPnl(services, validSignal(), state, 27, 1, "0", "-1000"))
      .toEqual({ approved: false, reason: "UTC daily-loss circuit breaker is active" });
  });

  it("fails closed when reconciled Demo PnL is missing", () => {
    const services = trackDb(testSystem());
    const state = services.botState.update({ enabled: true });

    expect(services.risk.dailyLossBreached(state)).toBe(true);
    expect(services.risk.approve(validSignal(), state, 27))
      .toEqual({ approved: false, reason: "Account PnL reconciliation is required" });
  });

  it("validates and audits AI advice without exposing provider output on rejection", async () => {
    const services = trackDb(testSystem());
    const audit = services.aiAudit;
    const noKey = new AiDecisionService("", "https://example.invalid/v1", "model", audit);
    await expect(noKey.advise({ candles: [], currentStrategy: "flat" })).rejects.toThrow("API key is not configured");
    expect(audit.recent()[0]?.accepted).toBe(false);

    const create = vi.fn(async () => ({
      choices: [{ message: { content: JSON.stringify({
        strategy: "flat",
        parameters: { maxLeverage: "2", riskPerTrade: "0.5", stopLoss: "1", riskRewardRatio: "2" },
        reasoning: "No trade."
      }) } }]
    }));
    const fakeClient = { chat: { completions: { create } } } as unknown as OpenAI;
    const ai = new AiDecisionService("configured", "https://example.invalid/v1", "model", audit, fakeClient);
    expect(await ai.advise({ candles: [], currentStrategy: "flat" })).toEqual({
      strategy: "flat",
      parameters: { maxLeverage: "2", riskPerTrade: "0.5", stopLoss: "1", riskRewardRatio: "2" },
      reasoning: "No trade."
    });
    expect(audit.recent()[0]?.accepted).toBe(true);
    const invalidClient = {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: '{"strategy":"unknown"}' } }] }) } }
    } as unknown as OpenAI;
    await expect(new AiDecisionService("key", "https://example.invalid/v1", "model", audit, invalidClient)
      .advise({ candles: [], currentStrategy: "flat" })).rejects.toThrow("response was invalid");
    expect(audit.recent()[0]).toMatchObject({ decision: "rejected", accepted: false });
    const unsafeParametersClient = {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
        strategy: "flat",
        parameters: { maxLeverage: "9", riskPerTrade: "0.5", stopLoss: "1", riskRewardRatio: "2" },
        reasoning: "Unsafe leverage"
      }) } }] }) } }
    } as unknown as OpenAI;
    await expect(new AiDecisionService("key", "https://example.invalid/v1", "model", audit, unsafeParametersClient)
      .advise({ candles: [], currentStrategy: "flat" })).rejects.toThrow("response was invalid");
    expect(audit.recent()[0]).toMatchObject({ decision: "rejected", accepted: false });
  });

  it("only applies AI risk settings within persisted operator caps", () => {
    const services = trackDb(testSystem());
    services.botState.update({
      strategy: "meanReversion", maxLeverage: 1.5, riskPerTrade: "0.4",
      stopLossPercent: "1.2", riskRewardRatio: "2"
    });
    const applied = applyAiDecision({
      strategy: "trendBreakout",
      parameters: { maxLeverage: "3", riskPerTrade: "1", stopLoss: "10", riskRewardRatio: "5" },
      reasoning: "Test bounds"
    }, services.botState, 3);
    expect(applied.parameters).toEqual({
      maxLeverage: "1.5", riskPerTrade: "0.4", stopLoss: "1.2", riskRewardRatio: "2"
    });
    expect(applied.state.strategy).toBe("trendBreakout");
  });

  it("maintains a reconnecting India websocket with heartbeat and sanitized events", async () => {
    class FakeSocket extends EventEmitter {
      readyState = 1;
      sent: string[] = [];
      pings = 0;
      send(data: string) { this.sent.push(data); }
      ping() { this.pings += 1; }
      close() { this.readyState = 3; this.emit("close"); }
      terminate() { this.readyState = 3; this.emit("close"); }
    }
    const sockets: FakeSocket[] = [];
    const stream = new DeltaMarketStream({
      reconnectMinMs: 5, reconnectMaxMs: 10, heartbeatMs: 50,
      socketFactory: (url) => {
        expect(url).toBe("wss://socket-ind.testnet.deltaex.org");
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as never;
      }
    });
    const errors: string[] = [];
    const tickerEvents: Array<{ markPrice: string; fundingRate: string | null }> = [];
    stream.on("streamError", (message: string) => errors.push(message));
    stream.on("ticker", (ticker: { markPrice: string; fundingRate: string | null }) => tickerEvents.push(ticker));
    stream.connect();
    sockets[0]!.emit("open");
    expect(sockets[0]!.sent[0]).toContain("v2/ticker");
    sockets[0]!.emit("message", Buffer.from('{"type":"ticker","ticker":{"symbol":"BTCUSD","mark_price":"100.25","funding_rate":"0.001"}}'));
    sockets[0]!.emit("message", Buffer.from("not-json"));
    expect(tickerEvents).toEqual([{ symbol: "BTCUSD", markPrice: "100.25", fundingRate: "0.001", receivedAt: expect.any(Number) }]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sockets[0]!.pings).toBeGreaterThan(0);
    sockets[0]!.emit("error");
    sockets[0]!.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets.length).toBeGreaterThan(1);
    expect(errors).toEqual(["Delta India market stream returned invalid JSON", "Delta India market stream error"]);
    stream.close();
  });

  it("streams live candles for every chart timeframe and rejects malformed candle frames", () => {
    class FakeSocket extends EventEmitter {
      readyState = 1;
      sent: string[] = [];
      send(data: string) { this.sent.push(data); }
      ping() {}
      close() { this.readyState = 3; this.emit("close"); }
      terminate() { this.close(); }
    }
    const socket = new FakeSocket();
    const urls: string[] = [];
    const stream = new DeltaMarketStream({
      heartbeatMs: 60_000,
      socketFactory: (url) => {
        urls.push(url);
        return socket as never;
      }
    });
    const candles: Array<{ timeframe: string; candle: Candle }> = [];
    stream.on("candle", (update: { timeframe: string; candle: Candle }) => candles.push(update));
    stream.connect();
    expect(urls).toEqual(["wss://socket-ind.testnet.deltaex.org"]);
    socket.emit("open");
    const subscribed = JSON.parse(socket.sent[0]!).payload.channels.map((channel: { name: string }) => channel.name);
    expect(subscribed).toEqual([
      "v2/ticker", "candlestick_1m", "candlestick_5m", "candlestick_15m", "candlestick_30m",
      "candlestick_1h", "candlestick_4h", "candlestick_1d", "candlestick_1w"
    ]);
    // Verbose frame as currently sent by Delta India.
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "candlestick_1m", symbol: "BTCUSD", resolution: "1m", open: 64317, high: 64332, low: 64317,
      close: 64319.5, volume: 2014, candle_start_time: 1794914040000000, timestamp: 1794914067442178
    })));
    // Compact documented frame without a start time: weekly bucket aligns to Monday 00:00 UTC.
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "candlestick_1w", sy: "BTCUSD", res: "1w", o: 65314, h: 65669, l: 63871, c: 64319.5, v: 10,
      ts: 1794914067442178
    })));
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "candlestick_5m", symbol: "BTCUSD", resolution: "5m", open: 10, high: 9, low: 8, close: 9,
      volume: 1, candle_start_time: 1794913800000000
    })));
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "candlestick_5m", symbol: "ETHUSD", resolution: "5m", open: 10, high: 11, low: 9, close: 10,
      volume: 1, candle_start_time: 1794913800000000
    })));
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "candlestick_3m", symbol: "BTCUSD", resolution: "3m", open: 10, high: 11, low: 9, close: 10,
      volume: 1, candle_start_time: 1794913800000000
    })));
    expect(candles).toEqual([
      { symbol: "BTCUSD", timeframe: "1m", candle: {
        timestamp: 1794914040000, open: "64317", high: "64332", low: "64317", close: "64319.5", volume: "2014"
      } },
      { symbol: "BTCUSD", timeframe: "1w", candle: {
        timestamp: 1794787200000, open: "65314", high: "65669", low: "63871", close: "64319.5", volume: "10"
      } }
    ]);
    expect(new Date(1794787200000).getUTCDay()).toBe(1);
    stream.close();
  });

  it("pushes validated worker candles only to dashboard websocket clients subscribed to that timeframe", async () => {
    const valid = {
      type: "candle",
      timeframe: "1m",
      candle: { timestamp: 1_794_914_040_000, open: "64317", high: "64332", low: "64317", close: "64319.5", volume: "2014" }
    };
    expect(parseWorkerCandleMessage(valid)).toEqual(valid);
    expect(parseWorkerCandleMessage({ ...valid, timeframe: "3m" })).toBeNull();
    expect(parseWorkerCandleMessage({ ...valid, candle: { ...valid.candle, close: "NaN" } })).toBeNull();
    expect(parseWorkerCandleMessage({ ...valid, candle: { ...valid.candle, timestamp: -1 } })).toBeNull();
    expect(parseWorkerCandleMessage("candle")).toBeNull();

    const httpServer = createServer();
    servers.push(httpServer);
    const hub = new LiveCandleHub(60_000);
    hub.attach(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const base = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
    const open = (path: string) => new Promise<{ socket: WebSocket; messages: unknown[] }>((resolve, reject) => {
      const socket = new WebSocket(`${base}${path}`);
      const messages: unknown[] = [];
      socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
      socket.on("open", () => resolve({ socket, messages }));
      socket.on("error", reject);
    });
    const oneMinute = await open("/api/stream?tf=1m");
    const fiveMinute = await open("/api/stream?tf=5m");
    await expect(open("/api/stream?tf=3m")).rejects.toThrow("400");
    await expect(open("/api/other?tf=1m")).rejects.toThrow();
    await vi.waitFor(() => expect(hub.clientCount).toBe(2));

    hub.broadcast(toLiveCandleEvent(parseWorkerCandleMessage(valid)!));
    const expected = {
      type: "candle",
      timeframe: "1m",
      candle: { time: 1_794_914_040, open: "64317", high: "64332", low: "64317", close: "64319.5", volume: "2014" }
    };
    await vi.waitFor(() => expect(oneMinute.messages).toEqual([{ type: "subscribed", timeframe: "1m" }, expected]));
    expect(fiveMinute.messages).toEqual([{ type: "subscribed", timeframe: "5m" }]);

    oneMinute.socket.close();
    await vi.waitFor(() => expect(hub.clientCount).toBe(1));
    hub.close();
    fiveMinute.socket.terminate();
  });

  it("migrates a legacy candle table to accept intraday chart timeframes without losing history", () => {
    const directory = mkdtempSync(join(tmpdir(), "sunny-candles-"));
    const path = join(directory, "bot.sqlite");
    try {
      const legacy = new BetterSqlite3(path);
      legacy.exec(`CREATE TABLE candles (
        symbol TEXT NOT NULL DEFAULT 'BTCUSD',
        timeframe TEXT NOT NULL CHECK (timeframe IN ('1h', '4h', '1d', '1w')),
        timestamp INTEGER NOT NULL, open TEXT NOT NULL, high TEXT NOT NULL, low TEXT NOT NULL,
        close TEXT NOT NULL, volume TEXT NOT NULL, PRIMARY KEY (symbol, timeframe, timestamp)
      );
      INSERT INTO candles VALUES ('BTCUSD', '1h', 3600000, '1', '2', '1', '2', '5');`);
      legacy.close();
      const db = createDatabase(path);
      const candles = new SqliteCandleRepository(db);
      expect(candles.list("1h")).toEqual([
        { timestamp: 3_600_000, open: "1", high: "2", low: "1", close: "2", volume: "5" }
      ]);
      candles.upsert("1m", [{ timestamp: 60_000, open: "1", high: "1", low: "1", close: "1", volume: "0" }]);
      expect(candles.list("1m")).toHaveLength(1);
      expect(() => candles.upsert("3m" as never, [
        { timestamp: 60_000, open: "1", high: "1", low: "1", close: "1", volume: "0" }
      ])).toThrow("CHECK constraint failed");
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes the persisted exchange mode and forces the bot paused during migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "sunny-bot-state-"));
    const path = join(directory, "bot.sqlite");
    try {
      const legacy = new BetterSqlite3(path);
      legacy.exec(`CREATE TABLE bot_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        kill_switch INTEGER NOT NULL DEFAULT 0,
        mode TEXT NOT NULL DEFAULT 'testnet',
        strategy TEXT NOT NULL DEFAULT 'flat',
        max_leverage REAL NOT NULL DEFAULT 3,
        max_daily_loss TEXT NOT NULL DEFAULT '1000',
        risk_per_trade TEXT NOT NULL DEFAULT '0.5',
        stop_loss_percent TEXT NOT NULL DEFAULT '1',
        risk_reward_ratio TEXT NOT NULL DEFAULT '2',
        strategy_instruction TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      INSERT INTO bot_state (id, enabled, mode, strategy, updated_at)
        VALUES (1, 1, 'testnet', 'meanReversion', 1000);`);
      legacy.close();

      const db = createDatabase(path);
      const state = new SqliteBotStateRepository(db).get();
      const columns = db.pragma("table_info(bot_state)") as Array<{ name: string }>;
      expect(state).toMatchObject({ enabled: false, strategy: "meanReversion" });
      expect(columns.some((column) => column.name === "mode")).toBe(false);
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serves intraday chart candles while keeping AI reevaluation on strategy timeframes", async () => {
    const services = trackDb(testSystem());
    services.candles.upsert("1m", [
      { timestamp: 60_000, open: "1", high: "2", low: "1", close: "2", volume: "3" },
      { timestamp: 120_000, open: "2", high: "3", low: "2", close: "3", volume: "4" }
    ]);
    const base = await start(createApp(services));
    const response = await fetch(`${base}/api/candles?tf=1m&limit=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      timeframe: "1m",
      candles: [{ time: 120, open: "2", high: "3", low: "2", close: "3", volume: "4" }]
    });
    for (const tf of ["5m", "15m", "30m"]) {
      expect((await fetch(`${base}/api/candles?tf=${tf}`)).status).toBe(200);
    }
    expect((await fetch(`${base}/api/candles?tf=3m`)).status).toBe(400);
    const ai = await fetch(`${base}/api/ai/decision`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeframe: "1m" })
    });
    expect(ai.status).toBe(400);
  });

  it("handles public Delta market data and explicit exchange failures", async () => {
    const client = new DeltaIndiaClient({
      apiKey: "", apiSecret: "", productId: 27
    }, async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("candles")) {
        return Response.json({ success: true, result: [
          { time: "99", open: 1, high: 2, low: 0.5, close: 1.5, volume: 4 },
          { time: "100", open: 1, high: 2, low: 0.5, close: 1.5, volume: 4 }
        ] });
      }
      return Response.json({ success: true, result: { mark_price: "1.5" } });
    });

    const found = await client.getCandles("1h", "BTCUSD", 20);
    expect(found[0]).toMatchObject({ timestamp: 99_000, close: "1.5", volume: "4" });
    expect(found.at(-1)).toMatchObject({ timestamp: 100_000 });
    expect(await client.getTicker("BTCUSD")).toEqual({ price: "1.5", fundingRate: null });

    const denied = new DeltaIndiaClient({
      apiKey: "", apiSecret: "", productId: 27
    }, async () => Response.json({ success: false, error: { code: "DENIED" } }));
    await expect(denied.getTicker("BTCUSD")).rejects.toThrow(DeltaApiError);
    await expect(denied.getBalances()).rejects.toThrow("credentials are not configured");

    const malformedCandleClient = new DeltaIndiaClient({
      apiKey: "", apiSecret: "", productId: 27
    }, async () => Response.json({
      success: true,
      result: [{ time: "99", open: 2, high: 1, low: 0.5, close: 1.5, volume: 4 }]
    }));
    await expect(malformedCandleClient.getCandles("1h", "BTCUSD", 20))
      .rejects.toThrow("candle record was invalid");
  });

  it("resolves and validates the BTCUSD product by its documented symbol endpoint", async () => {
    const requests: string[] = [];
    const testnet = new DeltaIndiaClient({
      apiKey: "", apiSecret: "", productId: 84, environment: "testnet"
    }, async (input) => {
      requests.push(String(input));
      return Response.json({
        success: true,
        result: {
          id: 84, symbol: "BTCUSD", state: "live", trading_status: "operational",
          contract_value: "0.001", tick_size: "0.1", initial_margin: "0.5"
        }
      });
    });
    await expect(testnet.getProductSpec()).resolves.toEqual({
      symbol: "BTCUSD", contractValue: "0.001", tickSize: "0.1", live: true, maxLeverage: "200"
    });
    expect(requests).toEqual(["https://cdn-ind.testnet.deltaex.org/v2/products/BTCUSD"]);

    const wrongId = new DeltaIndiaClient({
      apiKey: "", apiSecret: "", productId: 27, environment: "testnet"
    }, async () => Response.json({
      success: true,
      result: {
        id: 84, symbol: "BTCUSD", state: "live", trading_status: "operational",
        contract_value: "0.001", tick_size: "0.1"
      }
    }));
    await expect(wrongId.getProductSpec()).rejects.toThrow("did not match the configured BTCUSD contract");
  });

  it("uses documented Delta order filters and follows every open-order cursor", async () => {
    const calls: URL[] = [];
    const client = new DeltaIndiaClient({
      apiKey: "test-key", apiSecret: "test-secret", productId: 84
    }, async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      return Response.json({
        success: true,
        result: url.searchParams.get("after")
          ? [{ id: 2, product_id: 84 }]
          : [{ id: 1, product_id: 84 }],
        meta: { after: url.searchParams.get("after") ? null : "next-page", before: null }
      });
    });
    await expect(client.getOpenOrders()).resolves.toEqual([
      { id: 1, product_id: 84 }, { id: 2, product_id: 84 }
    ]);
    expect(calls).toHaveLength(2);
    for (const url of calls) {
      expect(url.pathname).toBe("/v2/orders");
      expect(url.searchParams.get("product_ids")).toBe("84");
      expect(url.searchParams.get("states")).toBe("open,pending");
      expect(url.searchParams.get("page_size")).toBe("100");
    }
    expect(calls[1]?.searchParams.get("after")).toBe("next-page");
  });

  it("normalizes exchange account telemetry and rejects incomplete account records", async () => {
    const client = new DeltaIndiaClient({
      apiKey: "test-key", apiSecret: "test-secret", productId: 27
    }, async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/wallet/balances")) {
        return Response.json({ success: true, result: [
          { asset_symbol: "USD", balance: "1200.5", available_balance: "800.5", order_margin: "100", position_margin: "300" }
        ] });
      }
      if (path.endsWith("/positions/margined")) {
        return Response.json({ success: true, result: [
          {
            id: 17, product_id: 27, product_symbol: "BTCUSD", size: "2", side: "buy",
            entry_price: "100", mark_price: "105", unrealized_pnl: "10", leverage: "2",
            bracket_stop_loss_price: "98", bracket_take_profit_price: "104"
          },
          {
            id: 18, product_id: 28, product_symbol: "ETHUSD", size: "-1", side: "sell",
            entry_price: "200", mark_price: "205", unrealized_pnl: "-5", leverage: "1"
          }
        ] });
      }
      return Response.json({
        success: true,
        result: [
          { id: 41, product_id: 27, product_symbol: "BTCUSD", side: "sell", size: "1",
            order_type: "limit_order", limit_price: "106", state: "open", created_at: "2026-01-01T00:00:00Z" }
        ],
        meta: { after: null, before: null }
      });
    });
    expect(await client.getAccountSnapshot()).toEqual({
      equity: "1200.5",
      availableMargin: "800.5",
      marginUsed: "400",
      unrealizedPnl: "5",
      positions: [{
        id: "17", productId: 27, symbol: "BTCUSD", side: "buy", quantity: "2",
        entryPrice: "100", markPrice: "105", unrealizedPnl: "10", leverage: "2",
        stopPrice: "98", takeProfitPrice: "104"
      }, {
        id: "18", productId: 28, symbol: "ETHUSD", side: "sell", quantity: "1",
        entryPrice: "200", markPrice: "205", unrealizedPnl: "-5", leverage: "1",
        stopPrice: null, takeProfitPrice: null
      }],
      openOrders: [{
        id: "41", productId: 27, symbol: "BTCUSD", side: "sell",
        orderType: "limit_order", quantity: "1", limitPrice: "106", status: "open",
        stopOrderType: null, triggerPrice: null,
        createdAt: "2026-01-01T00:00:00Z"
      }]
    });

    const invalid = new DeltaIndiaClient({
      apiKey: "test-key", apiSecret: "test-secret", productId: 27
    }, async (input) => {
      if (String(input).includes("/wallet/balances")) {
        return Response.json({ success: true, result: [{ asset_symbol: "BTC", balance: "1", available_balance: "1" }] });
      }
      return Response.json({ success: true, result: [], meta: { after: null, before: null } });
    });
    await expect(invalid.getAccountSnapshot()).rejects.toThrow("did not contain a USD balance");
  });

  it("allows only correctly sized, stopped, signed Delta India testnet orders", async () => {
    const services = trackDb(testSystem());
    const state = services.botState.update({ enabled: true });
    const decision = approveWithDemoPnl(services, validSignal(), state, 84, 2);
    expect(decision.approved).toBe(true);
    if (!decision.approved) return;
    expect(consumeRiskApproval(decision.approval)).toBe(true);
    let url = "";
    let body = "";
    const requests: Array<{ url: string; body: string; signature: string; timestamp: string }> = [];
    const gateway = new DeltaIndiaTestnetOrderGateway({
      apiKey: "test-key", apiSecret: "test-secret", productId: 84
    }, async (input, init) => {
      url = String(input);
      body = String(init?.body);
      const headers = init?.headers as Record<string, string>;
      requests.push({ url, body, signature: headers.signature!, timestamp: headers.timestamp! });
      return Response.json({ success: true, result: { id: "testnet-order" } });
    });

    const result = await gateway.placeOrder({
      productId: 84,
      side: decision.approval.side,
      quantity: decision.approval.quantity,
      leverage: decision.approval.leverage,
      stopPrice: decision.approval.stopPrice,
      takeProfitPrice: decision.approval.takeProfitPrice,
      clientOrderId: decision.approval.approvalId.replaceAll("-", "")
    }, decision.approval);
    expect(url).toBe("https://cdn-ind.testnet.deltaex.org/v2/orders");
    expect(JSON.parse(body)).toMatchObject({
      order_type: "market_order", bracket_stop_loss_price: "99", bracket_take_profit_price: "102",
      client_order_id: decision.approval.approvalId.replaceAll("-", "")
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("https://cdn-ind.testnet.deltaex.org/v2/products/84/orders/leverage");
    expect(JSON.parse(requests[0]!.body)).toEqual({ leverage: "2" });
    expect(requests[0]?.signature).toBe(createHmac("sha256", "test-secret")
      .update(`POST${requests[0]!.timestamp}/v2/products/84/orders/leverage${requests[0]!.body}`).digest("hex"));
    expect(result).toEqual({ id: "testnet-order" });
    await expect(gateway.placeOrder({
      productId: 84,
      side: "buy",
      quantity: "1",
      leverage: 1,
      stopPrice: "99",
      takeProfitPrice: "102",
      clientOrderId: "e".repeat(32)
    }, { approvalId: "forged" } as never)).rejects.toThrow("consumed matching RiskApproval");
    const fractional = approveWithDemoPnl(services, {
      ...validSignal(), referencePrice: "100000", stopPrice: "99000"
    }, state, 84, 2);
    expect(fractional.approved).toBe(true);
    if (!fractional.approved) return;
    expect(consumeRiskApproval(fractional.approval)).toBe(true);
    await expect(gateway.placeOrder({
      productId: 84,
      side: fractional.approval.side,
      quantity: fractional.approval.quantity,
      leverage: fractional.approval.leverage,
      stopPrice: fractional.approval.stopPrice,
      takeProfitPrice: fractional.approval.takeProfitPrice,
      clientOrderId: fractional.approval.approvalId.replaceAll("-", "")
    }, fractional.approval)).rejects.toThrow("whole contract quantity");
    await expect(gateway.placeOrder({
      productId: 84,
      side: "buy",
      quantity: "1",
      leverage: 4,
      stopPrice: "99",
      takeProfitPrice: "102",
      clientOrderId: "d".repeat(32)
    }, decision.approval)).rejects.toThrow("consumed matching RiskApproval");
  });

  it("sizes production orders in whole contracts, snaps brackets to the tick grid and uses the production host", async () => {
    const services = trackDb(testSystem());
    const state = services.botState.update({ enabled: true });
    const decision = approveWithDemoPnl(services, {
      ...validSignal(), referencePrice: "100000.3", stopPrice: "99000.3"
    }, state, 27, 2);
    expect(decision.approved).toBe(true);
    if (!decision.approved) return;
    expect(consumeRiskApproval(decision.approval)).toBe(true);
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const spec = { symbol: "BTCUSD", contractValue: "0.001", tickSize: "0.5", live: true, maxLeverage: "200" };
    const gateway = new DeltaIndiaTestnetOrderGateway({
      apiKey: "k", apiSecret: "s", productId: 27, environment: "production"
    }, async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Response.json({ success: true, result: { id: "live-order" } });
    }, async () => spec);
    const payload = {
      productId: 27, side: decision.approval.side, quantity: decision.approval.quantity,
      leverage: decision.approval.leverage, stopPrice: decision.approval.stopPrice,
      takeProfitPrice: decision.approval.takeProfitPrice,
      clientOrderId: decision.approval.approvalId.replaceAll("-", "")
    };
    await gateway.placeOrder(payload, decision.approval);
    expect(calls[1]?.url).toBe("https://api.india.delta.exchange/v2/orders");
    const size = String(calls[1]?.body.size);
    expect(typeof calls[1]?.body.size).toBe("number");
    expect(size).toMatch(/^\d+$/);
    expect(Number(size)).toBe(Math.floor(Number(decision.approval.quantity) / 0.001));
    expect(calls[1]?.body.bracket_stop_loss_price).toBe("99000.5");
    expect(calls[1]?.body.bracket_take_profit_price).toBe("102000");
    expect(calls[1]?.body.bracket_stop_trigger_method).toBe("mark_price");
    const wrongProduct = new DeltaIndiaTestnetOrderGateway({
      apiKey: "k", apiSecret: "s", productId: 27, environment: "production"
    }, async () => Response.json({ success: true, result: {} }), async () => ({ ...spec, symbol: "ETHUSD" }));
    await expect(wrongProduct.placeOrder(payload, decision.approval)).rejects.toThrow("live BTCUSD contract");
  });

  it("blocks production execution until live trading is explicitly confirmed", async () => {
    const services = trackDb(testSystem());
    const state = services.botState.update({ enabled: true });
    const decision = approveWithDemoPnl(services, validSignal(), state, 27);
    expect(decision.approved).toBe(true);
    if (!decision.approved) return;
    const execution = new ExecutionService(services.trades, { placeOrder: vi.fn() }, {
      ...services.config, deltaApiKey: "k", deltaApiSecret: "s", deltaEnvironment: "production", liveTradingConfirmed: false
    });
    await expect(execution.execute(decision.approval, state)).rejects.toThrow("live trading has not been confirmed");
    expect(loadConfig({ DELTA_ENV: "production" }).liveTradingConfirmed).toBe(false);
    expect(loadConfig({ DELTA_ENV: "production", LIVE_TRADING_CONFIRMED: "I_UNDERSTAND_REAL_MONEY" }).liveTradingConfirmed).toBe(true);
    expect(loadConfig({}).deltaEnvironment).toBe("testnet");
  });

  it("derives the daily loss cap as a percentage of start-of-day capital", () => {
    const services = trackDb(testSystem());
    const synced = syncDailyLossCap(services, { equity: "950", realizedPnl: "-50", unrealizedPnl: "0" });
    expect(synced.maxDailyLoss).toBe("500");
    const withUnrealized = syncDailyLossCap(services, { equity: "950", realizedPnl: "-50", unrealizedPnl: "-20" });
    expect(withUnrealized.maxDailyLoss).toBe("500");
    const capped = syncDailyLossCap(services, { equity: "1000000", realizedPnl: "0", unrealizedPnl: "0" });
    expect(capped.maxDailyLoss).toBe("1000");
    const below = syncDailyLossCap(services, { equity: "500.00001", realizedPnl: "-499.99999", unrealizedPnl: "0" });
    expect(below.maxDailyLoss).toBe("500");
    expect(services.risk.dailyLossBreached(below, "0", "-499.99999")).toBe(false);
    const boundary = syncDailyLossCap(services, { equity: "500", realizedPnl: "-500", unrealizedPnl: "0" });
    expect(services.risk.dailyLossBreached(boundary, "0", "-500")).toBe(true);
    services.config = { ...services.config, deltaEnvironment: "production" };
    expect(syncDailyLossCap(services, { equity: "1000", realizedPnl: "0", unrealizedPnl: "0" }).maxDailyLoss).toBe("20");
  });

  it("fails closed on missing testnet credentials and transport/provider errors", async () => {
    const services = trackDb(testSystem());
    const state = services.botState.update({ enabled: true });
    const issue = () => {
      const decision = approveWithDemoPnl(services, validSignal(), state, 27);
      if (!decision.approved) throw new Error("Expected test approval");
      expect(consumeRiskApproval(decision.approval)).toBe(true);
      return decision.approval;
    };
    const payload = (approval: ReturnType<typeof issue>) => ({
      productId: approval.productId,
      side: approval.side,
      quantity: approval.quantity,
      leverage: approval.leverage,
      stopPrice: approval.stopPrice,
      takeProfitPrice: approval.takeProfitPrice,
      clientOrderId: approval.approvalId.replaceAll("-", "")
    });
    const missingCredentials = new DeltaIndiaTestnetOrderGateway({
      apiKey: "", apiSecret: "", productId: 27
    });
    const missingCredentialApproval = issue();
    await expect(missingCredentials.placeOrder(payload(missingCredentialApproval), missingCredentialApproval))
      .rejects.toThrow("credentials are not configured");

    const configured = { apiKey: "key", apiSecret: "secret", productId: 27 };
    const transportFailure = new DeltaIndiaTestnetOrderGateway(configured, async () => {
      throw new Error("credential-bearing exception");
    });
    const transportApproval = issue();
    await expect(transportFailure.placeOrder(payload(transportApproval), transportApproval))
      .rejects.toThrow("order request failed");
    const httpFailure = new DeltaIndiaTestnetOrderGateway(configured, async () => new Response("denied", { status: 503 }));
    const httpApproval = issue();
    await expect(httpFailure.placeOrder(payload(httpApproval), httpApproval))
      .rejects.toThrow("HTTP 503");
    const invalidJson = new DeltaIndiaTestnetOrderGateway(configured, async () => new Response("not-json", { status: 200 }));
    const invalidJsonApproval = issue();
    await expect(invalidJson.placeOrder(payload(invalidJsonApproval), invalidJsonApproval))
      .rejects.toThrow("invalid response");
    const rejected = new DeltaIndiaTestnetOrderGateway(configured, async () =>
      Response.json({ success: false, error: { code: "STOP_UNAVAILABLE" } }));
    const rejectedApproval = issue();
    await expect(rejected.placeOrder(payload(rejectedApproval), rejectedApproval))
      .rejects.toThrow("STOP_UNAVAILABLE");
  });

  it("persists candles, status, bot settings, trades, and exact decimal PnL", () => {
    const services = trackDb(testSystem());
    const state = services.botState.update({
      enabled: true, strategy: "gridScalper", maxLeverage: 2,
      maxDailyLoss: "500.01", riskPerTrade: "0.25", stopLossPercent: "1.5",
      riskRewardRatio: "2.5",
      instruction: "Only enter on confirmed signals."
    });
    expect(services.botState.get()).toMatchObject({
      strategy: "gridScalper", maxLeverage: 2, maxDailyLoss: "500.01", riskRewardRatio: "2.5"
    });
    services.status.set("market_websocket", "connected");
    expect(services.status.get("market_websocket")).toBe("connected");
    expect(services.status.getUpdatedAt("market_websocket")).toBeGreaterThan(0);
    services.candles.upsert("4h", candlesFrom([10, 11]));
    expect(services.candles.list("4h", 1)).toMatchObject([{ close: "11" }]);
    services.candles.upsert("4h", candlesFrom([20]), "ETHUSD");
    expect(services.candles.list("4h", 1, "ETHUSD")[0]?.close).toBe("20");
    expect(services.candles.latestPrice()).toBe("11");
    services.trades.record({
      productId: 27, side: "sell", status: "submitted", quantity: "1",
      price: "20", stopPrice: "21", takeProfitPrice: "17.5", pnl: null, clientOrderId: "demo-order"
    });
    expect(services.trades.recent(1)[0]).toMatchObject({ status: "submitted", pnl: null });
    expect(services.trades.dailyRealizedPnl()).toBe("0");
    expect(services.aiAudit.recent(1)).toEqual([]);
    expect(state.updatedAt).toBeGreaterThan(0);
  });

  it("rejects invalid risk engine construction", () => {
    expect(() => new RiskCore("0", 2)).toThrow("Risk limit must be positive");
    expect(() => new RiskCore("100", 3)).toThrow("Leverage cap must be in (0, 2]");
  });

  it("rejects strategy leverage above 2x even if an injected configuration allows 3x", async () => {
    const services = trackDb(testSystem());
    services.config = { ...services.config, maxLeverage: 3 };
    const base = await start(createApp(services));
    const response = await fetch(`${base}/api/strategy`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "flat", parameters: { maxLeverage: "2.01" }, instruction: "" })
    });
    expect(response.status).toBe(400);
    expect(services.botState.get().maxLeverage).toBe(2);
  });

  it("signs authenticated reads with the exact timestamp and Demo endpoint", async () => {
    let url = "";
    let timestamp = "";
    let signature = "";
    const secret = "test-secret";
    const client = new DeltaIndiaClient({
      apiKey: "test-key", apiSecret: secret, productId: 27
    }, async (input, init) => {
      url = String(input);
      const headers = init?.headers as Record<string, string>;
      timestamp = headers.timestamp!;
      signature = headers.signature!;
      return Response.json({ success: true, result: { ok: true } });
    });
    expect(await client.getBalances()).toEqual({ ok: true });
    expect(url).toBe("https://cdn-ind.testnet.deltaex.org/v2/wallet/balances");
    expect(deltaIndiaEndpoints).toEqual({ demo: "https://cdn-ind.testnet.deltaex.org" });
    expect(signature).toBe(createHmac("sha256", secret).update(`GET${timestamp}/v2/wallet/balances`).digest("hex"));
  });
});
