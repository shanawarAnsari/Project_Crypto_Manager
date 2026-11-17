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

const databases: ReturnType<typeof createDatabase>[] = [];
const servers: Server[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) server.close();
  for (const db of databases.splice(0)) db.close();
});
function system() {
  let now = Date.UTC(2026, 10, 18, 12, 0, 15);
  const db = createDatabase(":memory:");
  databases.push(db);
  const config = loadConfig({ DELTA_ENV: "testnet", DELTA_DEMO_API_KEY: "test", DELTA_DEMO_API_SECRET: "test" });
  const botState = new SqliteBotStateRepository(db);
  const trades = new SqliteTradeRepository(db);
  const audit = new SqliteAiAuditRepository(db);
  const delta = new DeltaIndiaClient({ apiKey: "test", apiSecret: "test", productId: 84, environment: "testnet" });
  const risk = new RiskCore(config.maxDailyLoss, config.maxLeverage);
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
      orders.set(approval.approvalId.replaceAll("-", ""), { productId: 84, side: approval.side, contracts: "4",
        unfilledContracts: "0", averageFillPrice: "100100", paidCommission: "0.236", state: "closed", stopPrice: null, takeProfitPrice: null });
      account.positions = [];
      return {};
    })
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
  vi.spyOn(delta, "getProductSpec").mockResolvedValue({ symbol: "BTCUSD", live: true, contractValue: "0.001", tickSize: "0.5" });
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
      if (mode === "daily") s.account.realizedPnl = "-112";
      if (mode === "fees") vi.mocked(s.services.delta.getAgentFeeRate).mockResolvedValue("0.02");
      if (mode === "exposure") s.account.positions = [{ id: "external", productId: 84, symbol: "BTCUSD", side: "buy",
        quantity: "1", entryPrice: "100000", markPrice: "100000", unrealizedPnl: "0", leverage: "1", stopPrice: null, takeProfitPrice: null }];
      if (mode === "orders") s.account.openOrders = [{ id: "external", productId: 84, symbol: "BTCUSD", side: "buy",
        orderType: "limit", quantity: "1", limitPrice: "99900", status: "open", createdAt: new Date().toISOString() }];
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
    const response = await post("preview", { side: "buy" });
    const preview = await response.json() as { token: string };
    expect(response.status).toBe(200);
    expect((await post("confirm", { token: preview.token })).status).toBe(400);
    expect(s.orderGateway.placeOrder).not.toHaveBeenCalled();
    expect((await post("confirm", { token: preview.token, confirmation: "PLACE_DEMO_TEST_ORDER" })).status).toBe(200);
    expect((await post("confirm", { token: preview.token, confirmation: "PLACE_DEMO_TEST_ORDER" })).status).toBe(409);
    expect(s.orderGateway.placeOrder).toHaveBeenCalledTimes(1);
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
    s.account.realizedPnl = "-112";
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
    s.account.realizedPnl = "-112";
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
