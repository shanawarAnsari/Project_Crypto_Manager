import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/persistence/database.js";
import { SqliteAiAuditRepository, SqliteBotStateRepository, SqliteCandleRepository,
  SqliteServiceStatusRepository, SqliteTradeRepository } from "../src/persistence/repositories.js";
import { DeltaIndiaClient, type DeltaAccountRiskSnapshot, type DeltaAgentOrder } from "../src/exchange/delta-client.js";
import { loadConfig } from "../src/config.js";
import { RiskCore } from "../src/risk-core/risk-core.js";
import { ExecutionService } from "../src/execution/execution-service.js";
import { AiDecisionService } from "../src/ai/decision-service.js";
import { TradingAgent } from "../src/ai/trading-agent.js";
import { AgentRepository } from "../src/ai/agent-repository.js";
import type { AgentDecision } from "../src/ai/agent-types.js";
import type { AppServices } from "../src/services.js";
import { createApp } from "../src/app.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Decimal from "decimal.js";
import { hasConsumedEmergencyCloseApproval } from "../src/risk-core/risk-core.js";

const databases: ReturnType<typeof createDatabase>[] = [];
const servers: Server[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) server.close();
  for (const db of databases.splice(0)) db.close();
});
function system(maxLeverage = 2) {
  let now = Date.UTC(2026, 10, 18, 12, 0, 15);
  const db = createDatabase(":memory:");
  databases.push(db);
  const config = loadConfig({ DELTA_ENV: "testnet", DELTA_DEMO_API_KEY: "test", DELTA_DEMO_API_SECRET: "test", MAX_LEVERAGE: String(maxLeverage) });
  const botState = new SqliteBotStateRepository(db);
  const trades = new SqliteTradeRepository(db);
  const audit = new SqliteAiAuditRepository(db);
  const delta = new DeltaIndiaClient({ apiKey: "test", apiSecret: "test", productId: 84, environment: "testnet" });
  const risk = new RiskCore(config.maxDailyLoss, config.maxLeverage, config.deltaEnvironment);
  const account: DeltaAccountRiskSnapshot = { equity: "1000", availableMargin: "1000", marginUsed: "0",
    realizedPnl: "0", unrealizedPnl: "0", positions: [], openOrders: [] };
  const orders = new Map<string, DeltaAgentOrder>();
  const orderGateway = {
    placeOrder: vi.fn(async (payload: { clientOrderId: string; side: "buy" | "sell"; quantity: string;
      leverage: number; stopPrice: string; takeProfitPrice: string }) => {
      const contracts = new Decimal(payload.quantity).div("0.001").toString();
      orders.set(payload.clientOrderId, { productId: 84, side: payload.side, contracts, unfilledContracts: "0",
        averageFillPrice: "100000", paidCommission: "0.236", state: "closed", stopPrice: payload.stopPrice, takeProfitPrice: payload.takeProfitPrice });
      account.positions = [{ id: "owned", productId: 84, symbol: "BTCUSD", side: payload.side,
        quantity: contracts, entryPrice: "100000", markPrice: "100000", unrealizedPnl: "0",
        leverage: String(payload.leverage), stopPrice: payload.stopPrice, takeProfitPrice: payload.takeProfitPrice }];
      return {};
    }),
    closeAgentPosition: vi.fn(async (approval: Parameters<ExecutionService["closeAgentPosition"]>[0]) => {
      orders.set(approval.approvalId.replaceAll("-", ""), { productId: 84, side: approval.side, contracts: approval.contracts,
        unfilledContracts: "0", averageFillPrice: "100100", paidCommission: "0.236", state: "closed", stopPrice: null, takeProfitPrice: null });
      account.positions = account.positions.filter((position) => position.productId !== approval.productId);
      return {};
    }),
    cancelAllOrders: vi.fn(async (productId: number, approval: Parameters<ExecutionService["emergencyHalt"]>[0]) => {
      expect(hasConsumedEmergencyCloseApproval(approval)).toBe(true);
      account.openOrders = account.openOrders.filter((order) => order.productId !== productId);
      return {};
    }),
    closeAllPositions: vi.fn(async (productId: number, approval: Parameters<ExecutionService["emergencyHalt"]>[0]) => {
      expect(hasConsumedEmergencyCloseApproval(approval)).toBe(true);
      account.positions = account.positions.filter((position) => position.productId !== productId);
      return {};
    }),
    confirmNoOpenOrders: vi.fn(async (productId: number) => !account.openOrders.some((order) => order.productId === productId)),
    confirmNoOpenPositions: vi.fn(async (productId: number) => !account.positions.some((position) => position.productId === productId))
  };
  const execution = new ExecutionService(trades, orderGateway, config);
  const services: AppServices = { db, config, botState, trades, delta, risk, execution, aiAudit: audit,
    ai: new AiDecisionService("", config.nimBaseUrl, config.aiModel, audit),
    candles: new SqliteCandleRepository(db), status: new SqliteServiceStatusRepository(db) };
  vi.spyOn(delta, "getCandles").mockImplementation(async (tf) => {
    const periods = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000 };
    const period = periods[tf];
    return Array.from({ length: 31 }, (_, i) => ({ timestamp: Math.floor(now / period) * period - (30 - i) * period,
      open: "100000", high: "100100", low: "99900", close: "100000", volume: "1" }));
  });
  vi.spyOn(delta, "getAccountRiskSnapshot").mockImplementation(async () => structuredClone(account));
  vi.spyOn(delta, "getProductSpec").mockResolvedValue({ symbol: "BTCUSD", live: true, contractValue: "0.001", tickSize: "0.5", maxLeverage: "200" });
  vi.spyOn(delta, "getAgentFeeRate").mockResolvedValue("0.00059");
  vi.spyOn(delta, "getTicker").mockResolvedValue({ price: "100000", fundingRate: "0" });
  vi.spyOn(delta, "getAgentOrder").mockImplementation(async (id) => {
    const order = orders.get(id);
    if (!order) throw new Error("Order read-back unavailable");
    return order;
  });
  const decide = vi.fn<() => Promise<AgentDecision>>().mockResolvedValue({ action: "wait", summary: "No opportunity." });
  const model = { configured: true, decide };
  const repository = new AgentRepository(db);
  const agent = new TradingAgent(services, repository, model, () => now);
  return { services, agent, repository, model, orderGateway, account, orders, advance: (ms = 300_000) => { now += ms; } };
}
const entry: AgentDecision = { action: "open", side: "buy", stopPrice: "99000", takeProfitPrice: "102000", marginPercent: "25", leverage: 2, summary: "A measured entry." };

describe("durable Demo trading agent", () => {
  it.each(["hold", "close"] as const)("rejects a phantom %s before accepted audit or assistant display", async (action) => {
    const s = system();
    s.repository.event("assistant", "An active buy position exists; holding as per existing trade thesis.");
    s.services.botState.update({ enabled: true });
    s.model.decide.mockResolvedValueOnce({ action, summary: "An active buy position exists." });
    await s.agent.tick();
    expect(s.model.decide).toHaveBeenCalledWith(expect.objectContaining({
      activeTrade: null, positionState: "flat", allowedActions: ["wait", "open"],
      account: expect.objectContaining({ positions: [], openOrders: [] })
    }), false);
    expect(s.repository.events().filter((event) => event.role === "assistant")).toHaveLength(1);
    expect(s.repository.events().at(-1)?.message).toContain("no verified open app-owned BTCUSD position");
    const audit = s.services.db.prepare("SELECT accepted FROM ai_decision_audit ORDER BY id DESC LIMIT 1").get();
    expect(audit).toMatchObject({ accepted: 0 });
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch: true });
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
    expect(s.model.decide).toHaveBeenCalledTimes(1);
  });
  it("allows HOLD only for verified owned exposure and rechecks it before publication", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    s.model.decide.mockResolvedValueOnce({ action: "hold", summary: "Keep the verified owned buy." });
    const reads = vi.mocked(s.services.delta.getAccountRiskSnapshot).mock.calls.length;
    await s.agent.tick();
    expect(s.model.decide).toHaveBeenCalledWith(expect.objectContaining({
      positionState: "owned-open", activeTrade: expect.objectContaining({ status: "open", side: "buy" }),
      allowedActions: ["wait", "hold", "close"]
    }), false);
    expect(s.services.delta.getAccountRiskSnapshot).toHaveBeenCalledTimes(reads + 2);
    expect(s.repository.events().some((event) => event.role === "assistant" && event.message.includes("Action: HOLD"))).toBe(true);
    expect(s.services.botState.get().killSwitch).toBe(false);
  });
  it("does not publish HOLD if the exchange position closes while the model is responding", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    s.model.decide.mockImplementationOnce(async () => {
      s.account.positions = [];
      return { action: "hold", summary: "Still holding the old buy." };
    });
    await s.agent.tick();
    expect(s.repository.activeTrade()).toBeNull();
    expect(s.repository.events().some((event) => event.role === "assistant" && event.message.includes("Action: HOLD"))).toBe(false);
    expect(s.repository.events().at(-1)?.message).toContain("no verified open app-owned BTCUSD position");
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
  });
  it("reconciles an exited saved trade before supplying chat context while paused", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    s.account.positions = [];
    s.services.botState.update({ enabled: false });
    s.agent.send("Do I still have a position?");
    await vi.waitFor(() => expect(s.agent.snapshot().busy).toBe(false));
    expect(s.model.decide).toHaveBeenCalledWith(expect.objectContaining({
      positionState: "flat", activeTrade: null, allowedActions: ["wait"]
    }), true);
    expect(s.repository.activeTrade()).toBeNull();
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch: false });
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
  });
  it("treats missing telemetry as unavailable rather than a verified saved trade during chat", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    s.services.config = { ...s.services.config, deltaApiKey: "" };
    s.agent.send("What is my current position?");
    await vi.waitFor(() => expect(s.agent.snapshot().busy).toBe(false));
    expect(s.model.decide).toHaveBeenCalledWith(expect.objectContaining({
      positionState: "unavailable", activeTrade: null, account: null, allowedActions: ["wait"]
    }), true);
    expect(s.repository.activeTrade()).not.toBeNull();
  });
  it("does not answer chat using saved ownership when fresh account read-back fails", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    s.services.botState.update({ enabled: false });
    vi.mocked(s.services.delta.getAccountRiskSnapshot).mockRejectedValueOnce(new Error("Fresh account unavailable"));
    s.agent.send("Am I still holding the buy?");
    await vi.waitFor(() => expect(s.agent.snapshot().busy).toBe(false));
    expect(s.model.decide).not.toHaveBeenCalled();
    expect(s.repository.events().at(-1)?.message).toContain("Fresh account unavailable");
    expect(s.repository.activeTrade()).not.toBeNull();
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
  });
  it("rejects HOLD if owned position size changes during the model response", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    s.model.decide.mockImplementationOnce(async () => {
      s.account.positions[0]!.quantity = "2";
      return { action: "hold", summary: "Holding the same buy." };
    });
    await s.agent.tick();
    expect(s.repository.events().some((event) => event.role === "assistant" && event.message.includes("Action: HOLD"))).toBe(false);
    expect(s.repository.events().at(-1)?.message).toContain("ownership/size changed");
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch: true });
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
  });
  it("does not adopt external exposure as an owned position for HOLD", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    s.account.positions = [{ id: "external", productId: 84, symbol: "BTCUSD", side: "buy",
      quantity: "1", entryPrice: "100000", markPrice: "100000", unrealizedPnl: "0", leverage: "1",
      stopPrice: null, takeProfitPrice: null }];
    s.model.decide.mockResolvedValueOnce({ action: "hold", summary: "Hold the existing buy." });
    await s.agent.tick();
    expect(s.model.decide).toHaveBeenCalledWith(expect.objectContaining({
      positionState: "external", activeTrade: null, allowedActions: ["wait"]
    }), false);
    expect(s.repository.events().at(-1)?.message).toContain("no verified open app-owned BTCUSD position");
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
  });
  it.each(["buy", "sell"] as const)("previews and confirms a 100x %s test with narrowed protected brackets", async (side) => {
    const s = system(100);
    s.services.botState.update({ enabled: true, maxLeverage: 100 });
    s.account.equity = "2";
    s.account.availableMargin = "2";
    const preview = await s.agent.previewTestEntry(side, 100);
    expect(preview).toMatchObject({ side, leverage: 100, contracts: "1" });
    const distance = new Decimal(preview.entryPrice).minus(preview.stopPrice).abs();
    expect(distance.lt("1000")).toBe(true);
    const fees = new Decimal(preview.entryPrice).plus(Decimal.max(preview.entryPrice, preview.stopPrice, preview.takeProfitPrice)).mul("0.00059");
    expect(distance.plus(fees).mul("0.001").lte("0.6")).toBe(true);
    expect(new Decimal(preview.takeProfitPrice).minus(preview.entryPrice).abs().gt(fees)).toBe(true);
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    await s.agent.confirmTestEntry(preview.token);
    expect(s.orderGateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      leverage: 100, quantity: "0.001", stopPrice: preview.stopPrice, takeProfitPrice: preview.takeProfitPrice
    }), expect.anything());
    expect(s.repository.activeTrade()).toMatchObject({ status: "open", contracts: "1" });
  });
  it("uses the same 100x/100% policy for scheduled entries", async () => {
    const s = system(100);
    s.services.botState.update({ enabled: true, maxLeverage: 100 });
    s.model.decide.mockResolvedValueOnce({ ...entry, leverage: 100, marginPercent: "100" });
    await s.agent.tick();
    expect(s.model.decide).toHaveBeenCalledWith(expect.objectContaining({ policy: expect.objectContaining({
      maxLeverage: 100, maxMarginPercent: "100", maxPlannedLossPercentOfEquity: "30", dailyLossPercent: "50",
      maxEntriesPerUtcDay: 5
    }) }), false);
    expect(s.orderGateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ leverage: 100 }), expect.anything());
    expect(s.repository.activeTrade()).toMatchObject({ status: "open" });
  });
  it("rechecks the exchange leverage cap during confirmation and does not silently lower leverage", async () => {
    const s = system(100);
    s.services.botState.update({ enabled: true, maxLeverage: 100 });
    const preview = await s.agent.previewTestEntry("buy", 100);
    vi.mocked(s.services.delta.getProductSpec).mockResolvedValueOnce({
      symbol: "BTCUSD", live: true, contractValue: "0.001", tickSize: "0.5", maxLeverage: "50"
    });
    await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow("exchange product cap");
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow("already used");
  });
  it("refuses impossible test fee budgets instead of inventing a stop or submitting", async () => {
    const s = system(100);
    s.services.botState.update({ enabled: true, maxLeverage: 100 });
    s.account.equity = "0.1";
    s.account.availableMargin = "0.1";
    await expect(s.agent.previewTestEntry("buy", 100)).rejects.toThrow("budget cannot cover fees");
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
  });
  it("leaves external Demo BTCUSD positions/orders untouched when no app-owned trade exists", async () => {
    const s = system();
    s.account.positions = [84, 99].map((productId) => ({
      id: String(productId), productId, symbol: productId === 84 ? "BTCUSD" : "ETHUSD", side: "sell",
      quantity: "2", entryPrice: "100000", markPrice: "100000", unrealizedPnl: "0", leverage: "1",
      stopPrice: null, takeProfitPrice: null
    }));
    s.account.openOrders = [84, 99].map((productId) => ({
      id: String(productId), productId, symbol: productId === 84 ? "BTCUSD" : "ETHUSD", side: "buy",
      orderType: "market_order", quantity: "2", limitPrice: null, stopOrderType: "stop_loss_order",
      triggerPrice: "101000", status: "pending", createdAt: ""
    }));
    await s.agent.closeAllDemoPositions();
    expect(s.account.positions.map((position) => position.productId)).toEqual([84, 99]);
    expect(s.account.openOrders.map((order) => order.productId)).toEqual([84, 99]);
    expect(s.orderGateway.cancelAllOrders).not.toHaveBeenCalled();
    expect(s.orderGateway.closeAllPositions).not.toHaveBeenCalled();
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch: false });
    expect(s.repository.activeTrade()).toBeNull();
    expect(s.model.decide).not.toHaveBeenCalled();
  });
  it("clears confirmed owned trade state after manual close and invalidates outstanding previews", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    await s.agent.closeAllDemoPositions();
    expect(s.repository.activeTrade()).toBeNull();
    expect(s.services.botState.get()).toMatchObject({ enabled: true, killSwitch: false });
    expect(s.orderGateway.closeAgentPosition).toHaveBeenCalledWith(expect.objectContaining({
      intent: "manual-owned-close", contracts: "1"
    }));
    expect(s.orderGateway.cancelAllOrders).not.toHaveBeenCalled();
    await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow("invalid");
    expect(s.orderGateway.placeOrder).toHaveBeenCalledTimes(1);
  });
  it.each(["production", "credentials", "stopped"] as const)("refuses manual Demo close-all for %s without mutation", async (mode) => {
    const s = system();
    if (mode === "production") s.services.config = { ...s.services.config, deltaEnvironment: "production" };
    if (mode === "credentials") s.services.config = { ...s.services.config, deltaApiKey: "" };
    if (mode === "stopped") await s.agent.stop();
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow();
    expect(s.orderGateway.cancelAllOrders).not.toHaveBeenCalled();
    expect(s.orderGateway.closeAllPositions).not.toHaveBeenCalled();
    expect(s.services.botState.get().killSwitch).toBe(false);
  });
  it.each([false, true])("closes app-owned exposure while paused with killSwitch=%s without enabling or unlocking", async (killSwitch) => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("sell");
    await s.agent.confirmTestEntry(preview.token);
    s.services.botState.update({ enabled: false, killSwitch });
    s.model.configured = false;
    await s.agent.closeAllDemoPositions();
    expect(s.repository.activeTrade()).toBeNull();
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch });
    expect(s.orderGateway.closeAgentPosition).toHaveBeenCalledTimes(1);
    expect(s.model.decide).not.toHaveBeenCalled();
  });
  it("continues scheduled automation after a verified manual exit and retains other products", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    const external = { ...s.account.positions[0]!, id: "external", productId: 99, symbol: "ETHUSD" };
    s.account.positions.push(external);
    await s.agent.closeAllDemoPositions();
    expect(s.account.positions).toEqual([external]);
    expect(s.services.botState.get()).toMatchObject({ enabled: true, killSwitch: false });
    expect(s.orderGateway.closeAllPositions).not.toHaveBeenCalled();
    expect(s.orderGateway.cancelAllOrders).not.toHaveBeenCalled();
    s.account.positions = [];
    s.model.decide.mockResolvedValueOnce(entry);
    s.advance();
    await s.agent.tick();
    expect(s.orderGateway.placeOrder).toHaveBeenCalledTimes(2);
    expect(s.repository.activeTrade()).toMatchObject({ status: "open" });
    expect(s.services.botState.get()).toMatchObject({ enabled: true, killSwitch: false });
  });
  it.each(["size", "side", "entry", "duplicate"] as const)("refuses mixed or changed owned exposure: %s", async (change) => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    const position = s.account.positions[0]!;
    if (change === "size") position.quantity = "2";
    if (change === "side") position.side = "sell";
    if (change === "entry") position.entryPrice = "100001";
    if (change === "duplicate") s.account.positions.push({ ...position, id: "external" });
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow("ownership/size changed");
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
    expect(s.orderGateway.cancelAllOrders).not.toHaveBeenCalled();
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch: true });
  });
  it("does not cancel external/residual orders or claim success after a flat exit", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    const order = { id: "external", productId: 84, symbol: "BTCUSD", side: "buy" as const,
      orderType: "limit", quantity: "1", limitPrice: "90000", stopOrderType: null, triggerPrice: null,
      status: "open", createdAt: "" };
    s.account.openOrders = [order];
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow("working orders remain");
    expect(s.account.openOrders).toEqual([order]);
    expect(s.repository.activeTrade()).toMatchObject({ status: "exit_pending" });
    expect(s.orderGateway.cancelAllOrders).not.toHaveBeenCalled();
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch: true });
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow("working orders remain");
    expect(s.orderGateway.closeAgentPosition).toHaveBeenCalledTimes(1);
  });
  it("requires authenticated complete close-order read-back before marking an owned exit closed", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    s.orderGateway.closeAgentPosition.mockImplementationOnce(async (approval) => {
      s.account.positions = [];
      s.orders.set(approval.approvalId.replaceAll("-", ""), { productId: 99, side: approval.side, contracts: approval.contracts,
        unfilledContracts: "0", averageFillPrice: "100100", paidCommission: "0.236", state: "closed",
        stopPrice: null, takeProfitPrice: null });
      return {};
    });
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow("exit has not been confirmed");
    expect(s.repository.activeTrade()).toMatchObject({ status: "exit_pending" });
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch: true });
  });
  it("never undoes an explicit Stop while a manual close is being verified", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    const original = s.orderGateway.closeAgentPosition.getMockImplementation()!;
    let finish!: () => void;
    s.orderGateway.closeAgentPosition.mockImplementationOnce((approval) => new Promise((resolve) => {
      finish = () => { void original(approval).then(resolve); };
    }));
    const closing = s.agent.closeAllDemoPositions();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    s.services.botState.update({ enabled: false });
    s.agent.invalidate();
    finish();
    await closing;
    expect(s.repository.activeTrade()).toBeNull();
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch: false });
  });
  it("locks on post-submission account failure without retrying the pending exit", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    const original = s.orderGateway.closeAgentPosition.getMockImplementation()!;
    s.orderGateway.closeAgentPosition.mockImplementationOnce(async (approval) => {
      await original(approval);
      vi.mocked(s.services.delta.getAccountRiskSnapshot).mockRejectedValueOnce(new Error("Exit account read-back unavailable"));
      return {};
    });
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow("Exit account read-back unavailable");
    expect(s.repository.activeTrade()).toMatchObject({ status: "exit_pending" });
    expect(s.orderGateway.closeAgentPosition).toHaveBeenCalledTimes(1);
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch: true });
  });
  it("refuses pending submissions without cancelling or closing external exposure", async () => {
    const s = system();
    vi.spyOn(s.services.trades, "hasPendingSubmission").mockReturnValue(true);
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow("unresolved submission");
    expect(s.orderGateway.closeAllPositions).not.toHaveBeenCalled();
    expect(s.orderGateway.cancelAllOrders).not.toHaveBeenCalled();
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch: true });
    expect(s.repository.events().at(-1)?.message).toContain("no automatic retry");
  });
  it("does not claim success or clear owned state when a close is not verified", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    s.orderGateway.closeAgentPosition.mockRejectedValueOnce(new Error("network"));
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow("network");
    expect(s.repository.activeTrade()).toMatchObject({ status: "exit_pending" });
    expect(s.orderGateway.closeAgentPosition).toHaveBeenCalledTimes(1);
    expect(s.services.botState.get().killSwitch).toBe(true);
  });
  it("requires final account read-back and preserves unresolved submissions even when flat", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    vi.spyOn(s.services.trades, "hasPendingSubmission").mockReturnValue(true);
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow("unresolved submission");
    expect(s.repository.activeTrade()).not.toBeNull();
    vi.mocked(s.services.trades.hasPendingSubmission).mockReturnValue(false);
    vi.mocked(s.services.delta.getAccountRiskSnapshot).mockRejectedValueOnce(new Error("Account unavailable"));
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow("Account unavailable");
    expect(s.services.botState.get().killSwitch).toBe(true);
  });
  it("fails closed when final account read-back still contains BTCUSD orders or positions", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    s.orderGateway.closeAgentPosition.mockImplementationOnce(async () => ({}));
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow("not confirmed");
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch: true });
    expect(s.repository.events().some((event) => event.message.startsWith("Demo close-all confirmed:"))).toBe(false);
  });
  it("refuses exchange mutation if risk will not issue a fresh owned-close approval", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    vi.spyOn(s.services.risk, "approveAgentClose").mockReturnValueOnce(null);
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow("Risk core refused");
    expect(s.orderGateway.cancelAllOrders).not.toHaveBeenCalled();
    expect(s.orderGateway.closeAllPositions).not.toHaveBeenCalled();
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
    expect(s.services.botState.get().killSwitch).toBe(true);
  });
  it("aborts a waiting manual close on shutdown without submitting exchange requests", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    let finish!: (decision: AgentDecision) => void;
    s.model.decide.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const review = s.agent.tick();
    await vi.waitFor(() => expect(s.model.decide).toHaveBeenCalled());
    const closing = s.agent.closeAllDemoPositions();
    const rejected = expect(closing).rejects.toThrow("runtime controls changed");
    const shutdown = s.agent.stop();
    finish({ action: "wait", summary: "No action." });
    await Promise.all([review, shutdown, rejected]);
    expect(s.orderGateway.cancelAllOrders).not.toHaveBeenCalled();
    expect(s.orderGateway.closeAllPositions).not.toHaveBeenCalled();
    expect(s.services.botState.get().killSwitch).toBe(true);
  });
  it("drains in-flight agent work and blocks new actions while closing", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    let finish!: (decision: AgentDecision) => void;
    s.model.decide.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const review = s.agent.tick();
    await vi.waitFor(() => expect(s.model.decide).toHaveBeenCalled());
    const closing = s.agent.closeAllDemoPositions();
    expect(s.services.botState.get()).toMatchObject({ enabled: true, killSwitch: false });
    expect(s.agent.safetyActionInProgress).toBe(true);
    expect(s.orderGateway.cancelAllOrders).not.toHaveBeenCalled();
    await expect(s.agent.closeAllDemoPositions()).rejects.toThrow("already in progress");
    await expect(s.agent.previewTestEntry("buy")).rejects.toThrow("busy");
    expect(() => s.agent.send("Hello")).toThrow("busy");
    finish(entry);
    await Promise.all([review, closing]);
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    expect(s.orderGateway.closeAllPositions).not.toHaveBeenCalled();
    expect(s.services.botState.get()).toMatchObject({ enabled: true, killSwitch: false });
    expect(s.agent.safetyActionInProgress).toBe(false);
  });
  it.each([2, 3])("discards a stale entry without locking while draining account refresh %s", async (waitingRead) => {
    const s = system();
    s.services.botState.update({ enabled: true });
    s.model.decide.mockResolvedValueOnce(entry);
    let reads = 0;
    let finish!: () => void;
    vi.mocked(s.services.delta.getAccountRiskSnapshot).mockImplementation(async () => {
      reads++;
      if (reads === waitingRead) await new Promise<void>((resolve) => { finish = resolve; });
      return structuredClone(s.account);
    });
    const review = s.agent.tick();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const closing = s.agent.closeAllDemoPositions();
    finish();
    await Promise.all([review, closing]);
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
    expect(s.services.botState.get()).toMatchObject({ enabled: true, killSwitch: false });
  });
  it("requires API confirmation and blocks Start/reset/duplicate close during the safety action", async () => {
    const s = system();
    const server = createServer(createApp(s.services, s.agent));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const post = (path: string, body: unknown) => fetch(`${url}/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    expect((await post("agent/close-all", {})).status).toBe(400);
    expect(s.orderGateway.cancelAllOrders).not.toHaveBeenCalled();
    s.services.config = { ...s.services.config, deltaEnvironment: "production" };
    expect((await post("agent/close-all", { confirmation: "CLOSE_ALL_DEMO_BTCUSD" })).status).toBe(400);
    expect((await post("agent/close-all", { confirmation: "CLOSE_OWNED_DEMO_BTCUSD" })).status).toBe(409);
    expect(s.services.botState.get().killSwitch).toBe(false);
    s.services.config = { ...s.services.config, deltaEnvironment: "testnet" };
    let finish!: () => void;
    vi.mocked(s.services.delta.getAccountRiskSnapshot).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(s.account); }));
    const closing = post("agent/close-all", { confirmation: "CLOSE_OWNED_DEMO_BTCUSD" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await post("bot/toggle", { enabled: true })).status).toBe(409);
    expect((await post("kill-switch", { active: false })).status).toBe(409);
    expect((await post("kill-switch", { active: true })).status).toBe(409);
    expect((await post("agent/close-all", { confirmation: "CLOSE_OWNED_DEMO_BTCUSD" })).status).toBe(409);
    finish();
    const response = await closing;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: false, trade: null });
    expect(s.orderGateway.closeAllPositions).not.toHaveBeenCalled();
  });
  it("previews one contract at 1x with the reported balance under the new 40% cap without submitting", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    s.account.equity = "198.21553076";
    s.account.availableMargin = s.account.equity;
    vi.mocked(s.services.delta.getTicker).mockResolvedValue({ price: "64027.5", fundingRate: "0" });
    const preview = await s.agent.previewTestEntry("buy");
    expect(preview).toMatchObject({ contracts: "1", leverage: 1, entryPrice: "64027.5" });
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    expect(s.model.decide).not.toHaveBeenCalled();
  });
  it.each(["buy", "sell"] as const)("preserves selected 2x leverage for one %s test contract through confirmation", async (side) => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry(side, 2);
    expect(preview).toMatchObject({ side, leverage: 2, contracts: "1" });
    expect(s.repository.events().some((event) => event.message.includes("contract at 2x"))).toBe(true);
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    await s.agent.confirmTestEntry(preview.token);
    expect(s.orderGateway.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ leverage: 2, quantity: "0.001" }), expect.anything());
    expect(s.model.decide).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 101, NaN, Infinity])("refuses unsupported test leverage %s before exchange reads", async (leverage) => {
    const s = system();
    s.services.botState.update({ enabled: true });
    await expect(s.agent.previewTestEntry("buy", leverage)).rejects.toThrow("leverage");
    expect(s.services.delta.getTicker).not.toHaveBeenCalled();
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
  });
  it("enforces lower leverage caps both at preview and after a 2x preview", async () => {
    const s = system();
    s.services.botState.update({ enabled: true, maxLeverage: 1 });
    await expect(s.agent.previewTestEntry("buy", 2)).rejects.toThrow("leverage");
    s.services.botState.update({ maxLeverage: 2 });
    const preview = await s.agent.previewTestEntry("buy", 2);
    s.services.botState.update({ maxLeverage: 1 });
    await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow("leverage");
    await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow("already used");
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
  });
  it("supplies the 40% policy to scheduled reviews and honors a 40% proposal", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    s.model.decide.mockResolvedValueOnce({ ...entry, marginPercent: "40" });
    await s.agent.tick();
    expect(s.model.decide).toHaveBeenCalledWith(expect.objectContaining({
      policy: expect.objectContaining({ maxMarginPercent: "100", maxPlannedLossPercentOfEquity: "30", maxEntriesPerUtcDay: 5, dailyLossPercent: "50" })
    }), false);
    expect(s.orderGateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ quantity: "0.007" }), expect.anything());
    expect(s.repository.activeTrade()).toMatchObject({ status: "open", contracts: "7" });
  });
  it.each(["buy", "sell"] as const)("previews without trading, then confirms one %s contract without an LLM signal", async (side) => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry(side);
    expect(preview).toMatchObject({ side, contracts: "1", leverage: 1, entryPrice: "100000",
      stopPrice: side === "buy" ? "99000" : "101000", takeProfitPrice: side === "buy" ? "102000" : "98000" });
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    expect(s.repository.entryCount(preview.expiresAt - 30_000)).toBe(0);
    const accountReads = vi.mocked(s.services.delta.getAccountRiskSnapshot).mock.calls.length;
    await s.agent.confirmTestEntry(preview.token);
    expect(s.services.delta.getAccountRiskSnapshot).toHaveBeenCalledTimes(accountReads + 2);
    expect(s.orderGateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(s.orderGateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      quantity: "0.001", leverage: 1, stopPrice: preview.stopPrice, takeProfitPrice: preview.takeProfitPrice
    }), expect.objectContaining({ quantity: "0.001" }));
    expect(s.repository.activeTrade()).toMatchObject({ status: "open", contracts: "1", side });
    expect(s.repository.entryCount(preview.expiresAt - 30_000)).toBe(1);
    expect(s.model.decide).not.toHaveBeenCalled();
    await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow("already used");
    expect(s.orderGateway.placeOrder).toHaveBeenCalledTimes(1);
  });
  it.each(["production", "paused", "locked", "credentials", "stopped"] as const)("refuses test preview when %s", async (mode) => {
    const s = system();
    s.services.botState.update({ enabled: mode !== "paused", killSwitch: mode === "locked" });
    if (mode === "production") s.services.config = { ...s.services.config, deltaEnvironment: "production" };
    if (mode === "credentials") s.services.config = { ...s.services.config, deltaApiKey: "" };
    if (mode === "stopped") await s.agent.stop();
    await expect(s.agent.previewTestEntry("buy")).rejects.toThrow();
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
  });
  it.each(["expired", "controls", "production", "paused", "locked", "margin", "daily", "fees", "exposure", "orders", "pending", "sixth", "price"] as const)(
    "revalidates test confirmation against %s", async (mode) => {
      const s = system();
      s.services.botState.update({ enabled: true });
      const preview = await s.agent.previewTestEntry("buy");
      if (mode === "expired") s.advance(30_000);
      if (mode === "controls") s.agent.invalidate();
      if (mode === "production") s.services.config = { ...s.services.config, deltaEnvironment: "production" };
      if (mode === "paused") s.services.botState.update({ enabled: false });
      if (mode === "locked") s.services.botState.update({ killSwitch: true });
      if (mode === "margin") s.account.availableMargin = "1";
      if (mode === "daily") s.account.realizedPnl = "-1000";
      if (mode === "fees") vi.mocked(s.services.delta.getAgentFeeRate).mockResolvedValue("0.03");
      if (mode === "exposure") s.account.positions = [{ id: "external", productId: 84, symbol: "BTCUSD", side: "buy",
        quantity: "1", entryPrice: "100000", markPrice: "100000", unrealizedPnl: "0", leverage: "1", stopPrice: null, takeProfitPrice: null }];
      if (mode === "orders") s.account.openOrders = [{ id: "external", productId: 84, symbol: "BTCUSD", side: "buy",
        orderType: "limit", quantity: "1", limitPrice: "99900", stopOrderType: null, triggerPrice: null,
        status: "open", createdAt: new Date().toISOString() }];
      if (mode === "pending") vi.spyOn(s.services.trades, "hasPendingSubmission").mockReturnValue(true);
      if (mode === "sixth") {
        for (let i = 0; i < 5; i++) s.services.db.prepare("INSERT INTO agent_trades(id,payload,created_at) VALUES(?,?,?)")
          .run(String(i), '{"status":"closed"}', preview.expiresAt - 30_000);
      }
      if (mode === "price") vi.mocked(s.services.delta.getTicker).mockResolvedValue({ price: "98000", fundingRate: "0" });
      await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow();
      expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
      await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow("already used");
    });
  it("serializes test operations and discards a confirmation invalidated during account refresh", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    let finish!: (account: DeltaAccountRiskSnapshot) => void;
    vi.mocked(s.services.delta.getAccountRiskSnapshot).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = s.agent.confirmTestEntry(preview.token);
    await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow("busy");
    await s.agent.tick();
    expect(s.model.decide).not.toHaveBeenCalled();
    s.agent.invalidate();
    finish(s.account);
    await expect(pending).rejects.toThrow("Controls changed");
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
  });
  it("locks unknown test submissions, preserves the attempt and never retries", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    s.orderGateway.placeOrder.mockRejectedValueOnce(new Error("network"));
    await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow("uncertain");
    expect(s.services.botState.get()).toMatchObject({ enabled: false, killSwitch: true });
    expect(s.repository.activeTrade()).toMatchObject({ status: "entry_pending", contracts: "1" });
    expect(s.repository.entryCount(preview.expiresAt - 30_000)).toBe(1);
    await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow("already used");
    expect(s.orderGateway.placeOrder).toHaveBeenCalledTimes(1);
  });
  it("requires strict API confirmation and consumes a test token only once", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const server = createServer(createApp(s.services, s.agent));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agent/test-entry`;
    const post = (path: string, body: unknown) => fetch(`${url}/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    expect((await post("preview", { side: "other" })).status).toBe(400);
    for (const leverage of [0, -1, 1.5, 101, "2", null]) {
      expect((await post("preview", { side: "buy", leverage })).status).toBe(400);
    }
    const response = await post("preview", { side: "buy" });
    expect(await response.json()).toMatchObject({ leverage: 1 });
    expect(response.status).toBe(200);
    const selected = await post("preview", { side: "buy", leverage: 2 });
    expect(selected.status).toBe(200);
    const preview = await selected.json() as { token: string; leverage: number };
    expect(preview.leverage).toBe(2);
    expect((await post("confirm", { token: preview.token })).status).toBe(400);
    expect((await post("confirm", { token: preview.token, confirmation: "PLACE_DEMO_TEST_ORDER", leverage: 1 })).status).toBe(400);
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    expect((await post("confirm", { token: preview.token, confirmation: "PLACE_DEMO_TEST_ORDER" })).status).toBe(200);
    expect((await post("confirm", { token: preview.token, confirmation: "PLACE_DEMO_TEST_ORDER" })).status).toBe(409);
    expect(s.orderGateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(s.orderGateway.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ leverage: 2 }), expect.anything());
  });
  it("uses exact-order read-back for chart brackets and exposes missing protection as unavailable", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    s.account.positions[0]!.stopPrice = null;
    s.account.positions[0]!.takeProfitPrice = null;
    s.account.positions[0]!.unrealizedPnl = "0.12";
    const server = createServer(createApp(s.services, s.agent));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dashboard`;
    const response = await (await fetch(url)).json();
    expect(response).toMatchObject({ accountStatus: "available", positions: [
      { quantity: "1", stopPrice: "99000", takeProfitPrice: "102000", unrealizedPnl: "0.12" }
    ] });
    const trade = s.repository.activeTrade()!;
    s.orders.set(trade.clientOrderId, { ...s.orders.get(trade.clientOrderId)!, takeProfitPrice: null });
    const unavailable = await (await fetch(url)).json();
    expect(unavailable).toMatchObject({ accountStatus: "unavailable", positions: [], orders: [] });
    expect(unavailable.accountError).toContain("bracket protection");
    expect(s.orderGateway.placeOrder).toHaveBeenCalledTimes(1);
  });
  it("rejects chart ownership mismatches and never supplies proposed brackets for unconfirmed positions", async () => {
    const s = system();
    expect(await s.agent.verifiedPositionProtection(s.account)).toBeNull();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    await s.agent.confirmTestEntry(preview.token);
    s.account.positions[0]!.quantity = "2";
    await expect(s.agent.verifiedPositionProtection(s.account)).rejects.toThrow("ownership/size");
    const trade = s.repository.activeTrade()!;
    s.repository.saveTrade({ ...trade, status: "entry_pending" });
    expect(await s.agent.verifiedPositionProtection(s.account)).toBeNull();
  });
  it("invalidates old previews after replacement and runtime recreation", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const first = await s.agent.previewTestEntry("buy");
    const second = await s.agent.previewTestEntry("sell");
    const restored = new TradingAgent(s.services, s.repository, s.model);
    await expect(restored.confirmTestEntry(second.token)).rejects.toThrow("invalid");
    await expect(s.agent.confirmTestEntry(first.token)).rejects.toThrow("invalid");
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
  });
  it("requires a new preview if changed product ticks alter the confirmed brackets", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    vi.mocked(s.services.delta.getProductSpec).mockResolvedValue({ symbol: "BTCUSD", live: true, contractValue: "0.001", tickSize: "700", maxLeverage: "200" });
    await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow("bracket prices changed");
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
  });
  it("expires a confirmation during a slow refresh and awaits an in-flight test on shutdown", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    const preview = await s.agent.previewTestEntry("buy");
    vi.mocked(s.services.delta.getAgentFeeRate).mockImplementationOnce(async () => { s.advance(30_000); return "0.00059"; });
    await expect(s.agent.confirmTestEntry(preview.token)).rejects.toThrow("expired during validation");
    const next = await s.agent.previewTestEntry("buy");
    let finish!: (account: DeltaAccountRiskSnapshot) => void;
    vi.mocked(s.services.delta.getAccountRiskSnapshot).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const confirming = s.agent.confirmTestEntry(next.token);
    const rejected = expect(confirming).rejects.toThrow("Controls changed");
    const shutdown = s.agent.stop();
    finish(s.account);
    await Promise.all([shutdown, rejected]);
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
  });
  it("starts paused, defaults to 5m, and does not evaluate without Start", async () => {
    const s = system();
    await s.agent.tick();
    expect(s.agent.snapshot()).toMatchObject({ timeframe: "5m", enabled: false, nextReviewAt: null, trade: null });
    expect(s.model.decide).not.toHaveBeenCalled();
  });
  it("evaluates a closed candle once, including across runtime recreation", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    await s.agent.tick();
    await s.agent.tick();
    expect(s.model.decide).toHaveBeenCalledTimes(1);
    const restored = new TradingAgent(s.services, new AgentRepository(s.services.db), s.model);
    expect(restored.snapshot().events.some((e) => e.role === "assistant" &&
      e.message.includes("Action: WAIT") && e.message.includes("No opportunity."))).toBe(true);
    s.advance();
    await s.agent.tick();
    expect(s.model.decide).toHaveBeenCalledTimes(2);
  });
  it("opens and fully closes through risk and execution with durable thesis", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    s.model.decide.mockResolvedValueOnce(entry);
    await s.agent.tick();
    expect(s.orderGateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(s.repository.activeTrade()).toMatchObject({ status: "open", thesis: entry.summary, contracts: "4" });
    const entryEvents = s.repository.events();
    const response = entryEvents.find((e) => e.role === "assistant")!;
    expect(response.message).toBe([
      "Scheduled 5m review", "Action: OPEN", "Side: BUY", "Requested margin: 25% of USD equity",
      "Requested leverage: 2x", "Proposed stop: 99000", "Proposed target: 102000",
      "Summary: A measured entry.", "Proposal only; independent risk checks and exchange confirmation follow."
    ].join("\n"));
    expect(entryEvents.findIndex((e) => e.message.includes("Context ready"))).toBeLessThan(entryEvents.indexOf(response));
    expect(entryEvents.findIndex((e) => e.message.includes("Risk check:"))).toBeGreaterThan(entryEvents.indexOf(response));
    const acknowledgement = entryEvents.findIndex((e) => e.message.includes("Entry submission acknowledged"));
    expect(acknowledgement).toBeGreaterThan(entryEvents.indexOf(response));
    expect(entryEvents.findIndex((e) => e.message.includes("Entry fill confirmed"))).toBeGreaterThan(acknowledgement);
    s.advance();
    s.model.decide.mockResolvedValueOnce({ action: "close", summary: "The thesis is invalidated." });
    await s.agent.tick();
    expect(s.orderGateway.closeAgentPosition).toHaveBeenCalledTimes(1);
    expect(s.repository.activeTrade()).toBeNull();
    const exitEvents = s.repository.events();
    expect(exitEvents.some((e) => e.role === "assistant" && e.message.includes("Action: CLOSE") &&
      e.message.includes("The thesis is invalidated."))).toBe(true);
    expect(exitEvents.some((e) => e.message.includes("Exit submission acknowledged"))).toBe(true);
    expect(s.repository.entryCount(Date.UTC(2026, 10, 18, 12))).toBe(1);
  });
  it("chat is persistent analysis and cannot place or enable a trade", async () => {
    const s = system();
    s.agent.send("Please review BTC.");
    await vi.waitFor(() => expect(s.agent.snapshot().busy).toBe(false));
    expect(s.repository.conversation().map((e) => e.role)).toEqual(["user", "assistant"]);
    expect(s.model.decide).toHaveBeenCalledWith(expect.anything(), true);
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    expect(s.services.botState.get().enabled).toBe(false);
    expect(s.repository.conversation().at(-1)?.message).toContain("Chat analysis (no trading action)");
    expect(s.repository.conversation().at(-1)?.message).toContain("Action: WAIT");
    expect(s.repository.events().some((e) => e.message.includes("Chat complete. No order was authorized or submitted."))).toBe(true);
  });
  it("timeframe changes pause automation and invalidate pending decisions", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    s.model.decide.mockImplementationOnce(async () => { s.agent.setTimeframe("15m"); return entry; });
    await s.agent.tick();
    expect(s.agent.snapshot().timeframe).toBe("15m");
    expect(s.services.botState.get().enabled).toBe(false);
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
  });
  it("blocks external positions and does not adopt them", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    s.account.positions = [{ id: "external", productId: 84, symbol: "BTCUSD", side: "buy", quantity: "1",
      entryPrice: "100000", markPrice: "100000", leverage: "1", unrealizedPnl: "0", stopPrice: null, takeProfitPrice: null }];
    s.model.decide.mockResolvedValueOnce(entry);
    await s.agent.tick();
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    expect(s.services.botState.get().killSwitch).toBe(true);
  });
  it("locks uncertain submission without retrying", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    s.model.decide.mockResolvedValueOnce(entry);
    s.orderGateway.placeOrder.mockRejectedValueOnce(new Error("network"));
    await s.agent.tick();
    expect(s.services.botState.get().killSwitch).toBe(true);
    expect(s.repository.activeTrade()?.status).toBe("entry_pending");
    expect(s.services.trades.hasPendingSubmission(84)).toBe(true);
    s.advance();
    await s.agent.tick();
    expect(s.orderGateway.placeOrder).toHaveBeenCalledTimes(1);
  });
  it("does not execute after Stop while the model is responding", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    s.model.decide.mockImplementationOnce(async () => { s.services.botState.update({ enabled: false }); return entry; });
    await s.agent.tick();
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
  });
  it("rejects stale market data, unavailable fees and failed reconciliation", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    vi.spyOn(s.services.delta, "getAgentFeeRate").mockRejectedValueOnce(new Error("Fee unavailable"));
    s.model.decide.mockResolvedValueOnce(entry);
    await s.agent.tick();
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    expect(s.agent.snapshot().events.some((e) => e.role === "error")).toBe(true);
  });
  it("keeps actual daily PnL authoritative, including fees", async () => {
    const s = system();
    s.account.realizedPnl = "-1000";
    s.services.botState.update({ enabled: true });
    await s.agent.tick();
    expect(s.services.botState.get().killSwitch).toBe(true);
    expect(s.model.decide).not.toHaveBeenCalled();
  });
  it("fails closed on a stale candle without asking the model", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    vi.spyOn(s.services.delta, "getCandles").mockResolvedValue([]);
    await s.agent.tick();
    expect(s.model.decide).not.toHaveBeenCalled();
    expect(s.services.botState.get().killSwitch).toBe(true);
  });
  it("keeps monitoring risk between scheduled reviews", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    await s.agent.tick();
    s.account.realizedPnl = "-1000";
    await s.agent.tick();
    expect(s.services.botState.get().killSwitch).toBe(true);
    expect(s.model.decide).toHaveBeenCalledTimes(1);
  });
  it("never manages a position whose bracket protection cannot be verified", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    s.model.decide.mockResolvedValueOnce(entry);
    await s.agent.tick();
    const saved = s.repository.activeTrade()!;
    const order = s.orders.get(saved.clientOrderId)!;
    s.orders.set(saved.clientOrderId, { ...order, stopPrice: null });
    await s.agent.tick();
    expect(s.services.botState.get().killSwitch).toBe(true);
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
  });
  it("reconciles an exchange stop/target exit without submitting a duplicate exit", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    s.model.decide.mockResolvedValueOnce(entry);
    await s.agent.tick();
    s.account.positions = [];
    await s.agent.tick();
    expect(s.repository.activeTrade()).toBeNull();
    expect(s.orderGateway.closeAgentPosition).not.toHaveBeenCalled();
  });
  it("pauses on a provider failure and records an explicit error", async () => {
    const s = system();
    s.services.botState.update({ enabled: true });
    s.model.decide.mockRejectedValueOnce(new Error("NVIDIA unavailable"));
    await s.agent.tick();
    expect(s.agent.snapshot().events.at(-1)).toMatchObject({ role: "error", message: "NVIDIA decision was unavailable or invalid; no action was authorized" });
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
  });
  it("stops and awaits an in-flight chat before shutdown", async () => {
    const s = system();
    let finish!: (decision: AgentDecision) => void;
    s.model.decide.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    s.agent.send("Hello");
    await vi.waitFor(() => expect(s.model.decide).toHaveBeenCalled());
    const shutdown = s.agent.stop();
    finish({ action: "wait", summary: "Hello." });
    await shutdown;
    await s.agent.tick();
    expect(s.model.decide).toHaveBeenCalledTimes(1);
  });
  it("refuses a sixth daily entry", async () => {
    const s = system();
    for (let i = 0; i < 5; i++) {
      s.services.db.prepare("INSERT INTO agent_trades(id,payload,created_at) VALUES(?,?,?)").run(String(i), '{"status":"closed"}', Date.UTC(2026, 10, 18, 1));
    }
    s.services.botState.update({ enabled: true });
    s.model.decide.mockResolvedValueOnce(entry);
    await s.agent.tick();
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    expect(s.repository.events().some((e) => e.message.includes("Five-entry"))).toBe(true);
    expect(s.repository.events().some((e) => e.role === "assistant" && e.message.includes("Action: OPEN"))).toBe(true);
    expect(s.repository.events().some((e) => e.message.includes("Entry submission acknowledged"))).toBe(false);
  });
  it("validates API input and returns resumable persisted events", async () => {
    const s = system();
    const server = createServer(createApp(s.services, s.agent));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect((await fetch(`${url}/api/agent`)).status).toBe(200);
    const bad = await fetch(`${url}/api/agent/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"timeframe":"4h"}' });
    expect(bad.status).toBe(400);
    const invalidChat = await fetch(`${url}/api/agent/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"message":""}' });
    expect(invalidChat.status).toBe(400);
    const changed = await fetch(`${url}/api/agent/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"timeframe":"15m"}' });
    expect(await changed.json()).toMatchObject({ timeframe: "15m", enabled: false });
    const legacy = await fetch(`${url}/api/strategy`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"strategy":"flat"}' });
    expect(legacy.status).toBe(410);
    const event = s.repository.event("activity", "Persisted event");
    const controller = new AbortController();
    const response = await fetch(`${url}/api/agent/events?after=${event.id - 1}`, { signal: controller.signal });
    const chunk = await response.body!.getReader().read();
    expect(new TextDecoder().decode(chunk.value)).toContain("Persisted event");
    controller.abort();
  });
  it("rejects production Start and discards a Start invalidated by a later control", async () => {
    const s = system();
    const server = createServer(createApp(s.services, s.agent));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bot/toggle`;
    const start = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"enabled":true}' });
    s.services.config = { ...s.services.config, deltaEnvironment: "production" };
    expect((await start()).status).toBe(409);
    s.services.config = { ...s.services.config, deltaEnvironment: "testnet" };
    let finish!: (account: DeltaAccountRiskSnapshot) => void;
    vi.spyOn(s.services.delta, "getAccountRiskSnapshot").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = start();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    s.agent.invalidate();
    s.services.botState.update({ enabled: false });
    finish(s.account);
    expect((await pending).status).toBe(409);
    expect(s.services.botState.get().enabled).toBe(false);
  });
});
