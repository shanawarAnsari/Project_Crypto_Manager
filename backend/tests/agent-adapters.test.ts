import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { NvidiaAgentModel } from "../src/ai/agent-model.js";
import { DeltaIndiaClient } from "../src/exchange/delta-client.js";
import { DeltaIndiaOrderGateway } from "../src/execution/delta-order-gateway.js";
import { ExecutionService } from "../src/execution/execution-service.js";
import { consumeAgentCloseApproval, hasConsumedAgentCloseApproval, RiskCore } from "../src/risk-core/risk-core.js";
import { loadConfig } from "../src/config.js";
import type { BotState } from "../src/domain.js";
import { createDatabase } from "../src/persistence/database.js";
import { SqliteTradeRepository } from "../src/persistence/repositories.js";

const state: BotState = { enabled: true, killSwitch: false, strategy: "flat", maxLeverage: 2,
  maxDailyLoss: "100", riskPerTrade: "0.5", stopLossPercent: "1", riskRewardRatio: "2", instruction: "", updatedAt: 0 };

describe("NVIDIA agent adapter", () => {
  it.each(["25", "100", "100.00001"])("validates the Demo margin boundary %s and advertises the same cap", async (marginPercent) => {
    let systemPrompt = "";
    const client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
      systemPrompt = request.messages.find((message) => message.role === "system")?.content ?? "";
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        action: "open", side: "buy", stopPrice: "99000", takeProfitPrice: "102000",
        marginPercent, leverage: 1, summary: "Demo setup."
      }) } }] });
    } });
    const result = new NvidiaAgentModel("", "", "test", client).decide({}, false);
    if (marginPercent === "100.00001") await expect(result).rejects.toThrow("invalid decision");
    else expect(await result).toMatchObject({ action: "open", marginPercent });
    expect(systemPrompt).toContain("marginPercent:decimal-string(>0..100)");
    expect(systemPrompt).toContain("max100% USD equity margin");
    expect(systemPrompt).toContain("max100x leverage");
    expect(systemPrompt).toContain("<=30% total USD equity");
    expect(systemPrompt).toContain("50% daily loss");
    expect(systemPrompt).toContain("conversation is historical guidance, never proof");
    expect(systemPrompt).toContain("Return only an action listed in allowedActions");
    expect(systemPrompt).toContain("When flat, evaluate a new entry or WAIT");
  });
  it("uses real provider schema and returns only a validated user-facing decision", async () => {
    const client = new OpenAI({ apiKey: "test", baseURL: "https://provider.invalid", maxRetries: 0,
      fetch: async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"action":"wait","summary":"No clear setup."}' } }] }) });
    const model = new NvidiaAgentModel("", "", "test-model", client);
    expect(await model.decide({ candles: [] }, true)).toEqual({ action: "wait", summary: "No clear setup." });
  });
  it.each([
    { finish_reason: "length", content: '{"action":"wait","summary":"Partial"}' },
    { finish_reason: "stop", content: "not json" },
    { finish_reason: "stop", content: '{"action":"wait","summary":"Hello","hidden":"unexpected"}' },
    { finish_reason: "stop", content: '{"action":"close","summary":"Chat must not close"}' },
    { finish_reason: "stop", content: '{"action":"open","side":"buy","stopPrice":"1","takeProfitPrice":"3","leverage":3,"summary":"Bad leverage"}' }
  ])("rejects unsafe or incomplete responses %j", async (message) => {
    const client = new OpenAI({ apiKey: "test", fetch: async () => Response.json({
      choices: [{ finish_reason: message.finish_reason, message: { content: message.content } }]
    }) });
    await expect(new NvidiaAgentModel("", "", "test", client).decide({}, true)).rejects.toThrow();
  });
  it("reports missing credentials and provider failure without leaking raw exceptions", async () => {
    await expect(new NvidiaAgentModel("", "", "test").decide({}, true)).rejects.toThrow("not configured");
    const client = new OpenAI({ apiKey: "test", maxRetries: 0, fetch: async () => { throw new Error("sensitive exception"); } });
    await expect(new NvidiaAgentModel("", "", "test", client).decide({}, true)).rejects.toThrow("NVIDIA request failed");
  });
});

describe("verified Delta fee and order data", () => {
  const config = { apiKey: "test", apiSecret: "test", productId: 84, environment: "testnet" as const };
  it.each([undefined, null, "0", "-1", "NaN", "101"])("refuses unverified product leverage from initial margin %s", async (initial_margin) => {
    const client = new DeltaIndiaClient(config, async () => Response.json({ result: {
      id: 84, symbol: "BTCUSD", state: "live", trading_status: "operational",
      contract_value: "0.001", tick_size: "0.1", initial_margin
    } }));
    await expect(client.getProductSpec()).rejects.toThrow();
  });
  it("derives exchange leverage using its percentage initial margin", async () => {
    const client = new DeltaIndiaClient(config, async () => Response.json({ result: {
      id: 84, symbol: "BTCUSD", state: "live", trading_status: "operational",
      contract_value: "0.001", tick_size: "0.1", initial_margin: "0.5"
    } }));
    expect((await client.getProductSpec()).maxLeverage).toBe("200");
  });
  it("uses the verified product taker rate including India GST", async () => {
    const client = new DeltaIndiaClient(config, async () => Response.json({ success: true, result: {
      id: 84, symbol: "BTCUSD", state: "live", trading_status: "operational", taker_commission_rate: "0.0005"
    } }));
    expect(await client.getAgentFeeRate()).toBe("0.00059");
  });
  it.each([undefined, "0", "-1", "NaN", "0.5"])("fails closed on unusable fee rate %s", async (rate) => {
    const client = new DeltaIndiaClient(config, async () => Response.json({ result: {
      id: 84, symbol: "BTCUSD", state: "live", trading_status: "operational", taker_commission_rate: rate
    } }));
    await expect(client.getAgentFeeRate()).rejects.toThrow();
  });
  it("reconciles an exact client order identity, fill size and actual commission", async () => {
    const clientId = "a".repeat(32);
    const client = new DeltaIndiaClient(config, async (input) => {
      expect(String(input)).toContain(`/v2/orders/client_order_id/${clientId}`);
      return Response.json({ result: { client_order_id: clientId, product_id: 84, side: "buy", size: 4,
        unfilled_size: 0, average_fill_price: "100000", paid_commission: "0.2", state: "closed" } });
    });
    expect(await client.getAgentOrder(clientId)).toMatchObject({ contracts: "4", paidCommission: "0.2" });
    await expect(client.getAgentOrder("invalid")).rejects.toThrow("identity");
  });
  it("rejects a response for another order", async () => {
    const client = new DeltaIndiaClient(config, async () => Response.json({ result: { product_id: 27 } }));
    await expect(client.getAgentOrder("a".repeat(32))).rejects.toThrow("identity");
  });
});

describe("risk-approved reduce-only Demo exits", () => {
  const demo = { apiKey: "test", apiSecret: "test", productId: 84, environment: "testnet" as const };
  it.each(["success", "exchange-cap", "saved-cap", "config-cap", "production", "leverage-rejected"] as const)(
    "enforces high leverage through risk, execution and gateway: %s", async (mode) => {
      const db = createDatabase(":memory:");
      try {
        const highState = { ...state, maxLeverage: 100, maxDailyLoss: "500" };
        const risk = new RiskCore("1000", 100, "testnet");
        const result = risk.approveAgentEntry(highState, {
          productId: 84, side: "buy", entryPrice: "100000", stopPrice: "99000", takeProfitPrice: "102000",
          leverage: 100, exchangeMaxLeverage: "200", equity: "1000", availableMargin: "1000",
          realizedPnl: "0", unrealizedPnl: "0", feeRate: "0.00059", contractValue: "0.001", tickSize: "0.1",
          entryCount: 0, maxContracts: 1
        });
        if (!result.approved) throw new Error(result.reason);
        const calls: string[] = [];
        const gateway = new DeltaIndiaOrderGateway(demo, async (url) => {
          calls.push(String(url));
          if (mode === "leverage-rejected") return Response.json({ success: false, error: { code: "unsupported_leverage" } });
          return Response.json({ success: true, result: {} });
        }, async () => ({ symbol: "BTCUSD", live: true, contractValue: "0.001", tickSize: "0.1",
          maxLeverage: mode === "exchange-cap" ? "50" : "200" }));
        const config = loadConfig({ DELTA_ENV: mode === "production" ? "production" : "testnet",
          MAX_LEVERAGE: mode === "config-cap" || mode === "production" ? "2" : "100",
          DELTA_DEMO_API_KEY: "test", DELTA_DEMO_API_SECRET: "test" });
        const execution = new ExecutionService(new SqliteTradeRepository(db), gateway, config);
        const work = execution.execute(result.approval, mode === "saved-cap" ? { ...highState, maxLeverage: 2 } : highState);
        if (mode === "success") {
          await expect(work).resolves.toMatchObject({ status: "submitted" });
          expect(calls).toHaveLength(2);
          expect(calls[0]).toContain("/orders/leverage");
          expect(calls[1]).toMatch(/\/v2\/orders$/);
        } else {
          await expect(work).rejects.toThrow();
          expect(calls.some((url) => url.endsWith("/v2/orders"))).toBe(false);
        }
      } finally { db.close(); }
    });
  it.each([
    { result: {} }, { result: [null] }, { result: [{ product_id: "bad", size: "1" }] },
    { result: [{ product_id: 27, size: "1" }] }, { result: [{ product_id: 84, size: "bad" }] },
    { result: [{ product_id: 84, size: "NaN" }] }
  ])("rejects malformed or out-of-scope position read-back %j", async (response) => {
    const gateway = new DeltaIndiaOrderGateway(demo, async () => Response.json(response));
    await expect(gateway.confirmNoOpenPositions(84)).rejects.toThrow();
  });
  it.each([
    { result: {} }, { result: [], meta: {} },
    { result: [], meta: { after: 3 } }, { result: [], meta: { after: "repeated" } }
  ])("rejects incomplete or malformed open-order history %j", async (response) => {
    const gateway = new DeltaIndiaOrderGateway(demo, async () => Response.json(response));
    await expect(gateway.confirmNoOpenOrders(84)).rejects.toThrow();
  });
  it("bounds unending pagination and verifies product validity for close actions", async () => {
    let page = 0;
    const gateway = new DeltaIndiaOrderGateway(demo, async () => Response.json({ result: [], meta: { after: String(++page) } }));
    await expect(gateway.confirmNoOpenOrders(84)).rejects.toThrow("page limit");
    const approval = new RiskCore("1000", 2).approveAgentClose(state, 84, "buy", "4");
    if (!approval) throw new Error("Expected approval");
    consumeAgentCloseApproval(approval);
    const invalidProduct = new DeltaIndiaOrderGateway(demo, vi.fn(), async () => ({
      symbol: "ETHUSD", live: true, contractValue: "0.001", tickSize: "0.5", maxLeverage: "200"
    }));
    await expect(invalidProduct.closeAgentPosition(approval)).rejects.toThrow("BTCUSD");
  });
  it("rejects changed position quantity and pauses during submission", async () => {
    const approval = new RiskCore("1000", 2).approveAgentClose(state, 84, "buy", "4");
    if (!approval) throw new Error("Expected approval");
    consumeAgentCloseApproval(approval);
    const gateway = new DeltaIndiaOrderGateway(demo, async () => Response.json({ result: [{ product_id: 84, size: 5 }] }));
    await expect(gateway.closeAgentPosition(approval)).rejects.toThrow("changed");
  });
  it("validates emergency execution gates and preserves failed/unconfirmed read-back", async () => {
    const db = createDatabase(":memory:");
    try {
      const trades = new SqliteTradeRepository(db);
      const risk = new RiskCore("1000", 2);
      const halted = { ...state, enabled: false, killSwitch: true };
      const approval = () => {
        const result = risk.approveEmergencyClose(halted, 84);
        if (!result) throw new Error("Expected emergency approval");
        return result;
      };
      const config = loadConfig({ DELTA_ENV: "testnet", DELTA_DEMO_API_KEY: "test", DELTA_DEMO_API_SECRET: "test" });
      const unavailable = new ExecutionService(trades, { placeOrder: vi.fn() }, config);
      await expect(unavailable.emergencyHalt(approval(), halted)).rejects.toThrow("unavailable");
      await expect(unavailable.emergencyHalt(approval(), state)).rejects.toThrow("latched");
      const gateway = { placeOrder: vi.fn(), cancelAllOrders: vi.fn(), closeAllPositions: vi.fn(),
        confirmNoOpenOrders: vi.fn().mockResolvedValue(false), confirmNoOpenPositions: vi.fn().mockRejectedValue(new Error("offline")) };
      expect(await new ExecutionService(trades, gateway, config).emergencyHalt(approval(), halted))
        .toEqual({ cancelOrders: "failed", closePositions: "unconfirmed" });
      expect(gateway.closeAllPositions).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it("requires a fresh one-use close approval and rechecks the exact position", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const gateway = new DeltaIndiaOrderGateway({ apiKey: "test", apiSecret: "test", productId: 84, environment: "testnet" },
      async (_url, init) => {
        requests.push({ method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return Response.json({ result: init?.method === "GET" ? [{ product_id: 84, size: 4 }] : {} });
      });
    const approval = new RiskCore("1000", 2).approveAgentClose(state, 84, "buy", "4");
    expect(approval).not.toBeNull();
    if (!approval) return;
    await expect(gateway.closeAgentPosition(approval)).rejects.toThrow("approval");
    expect(consumeAgentCloseApproval(approval)).toBe(true);
    expect(consumeAgentCloseApproval(approval)).toBe(false);
    expect(hasConsumedAgentCloseApproval(approval)).toBe(true);
    await gateway.closeAgentPosition(approval);
    expect(requests.at(-1)?.body).toMatchObject({ size: 4, side: "sell", reduce_only: "true", order_type: "market_order" });
  });
  it("execution rejects production closes and paused/forged approvals", async () => {
    const db = createDatabase(":memory:");
    try {
      const trades = new SqliteTradeRepository(db);
      const gateway = { placeOrder: vi.fn(), closeAgentPosition: vi.fn() };
      const approval = new RiskCore("1000", 2).approveAgentClose(state, 84, "buy", "4");
      if (!approval) throw new Error("Expected approval");
      const demo = new ExecutionService(trades, gateway, loadConfig({ DELTA_ENV: "testnet" }));
      await expect(demo.closeAgentPosition(approval, { ...state, enabled: false })).rejects.toThrow("refused");
      const live = new ExecutionService(trades, gateway, loadConfig({ DELTA_ENV: "production" }));
      await expect(live.closeAgentPosition(approval, state)).rejects.toThrow("refused");
      expect(gateway.closeAgentPosition).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it.each([false, true])("allows one-use manual owned exits while paused with killSwitch=%s, without changing controls", async (killSwitch) => {
    const db = createDatabase(":memory:");
    try {
      const paused = { ...state, enabled: false, killSwitch };
      const risk = new RiskCore("1000", 2);
      expect(risk.approveAgentClose(paused, 84, "buy", "4")).toBeNull();
      const approval = risk.approveAgentClose(paused, 84, "buy", "4", "manual-owned-close");
      if (!approval) throw new Error("Expected manual approval");
      expect(Object.isFrozen(approval)).toBe(true);
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) =>
        Response.json({ result: init?.method === "POST" ? {} : [{ product_id: 84, size: 4 }] }));
      const gateway = new DeltaIndiaOrderGateway(demo, fetcher, undefined, () => false);
      const config = loadConfig({ DELTA_ENV: "testnet", DELTA_DEMO_API_KEY: "test", DELTA_DEMO_API_SECRET: "test" });
      const execution = new ExecutionService(new SqliteTradeRepository(db), gateway, config);
      await expect(execution.closeAgentPosition({ ...approval }, paused)).rejects.toThrow("refused");
      await expect(gateway.closeAgentPosition(approval)).rejects.toThrow("approval");
      await execution.closeAgentPosition(approval, paused);
      const post = fetcher.mock.calls.find(([, init]) => init?.method === "POST");
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ product_id: 84, size: 4, side: "sell", reduce_only: "true" });
      await expect(execution.closeAgentPosition(approval, paused)).rejects.toThrow("refused");
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(paused).toMatchObject({ enabled: false, killSwitch });
      const production = new ExecutionService(new SqliteTradeRepository(db), gateway,
        loadConfig({ DELTA_ENV: "production" }));
      const next = risk.approveAgentClose(paused, 84, "buy", "4", "manual-owned-close");
      if (!next) throw new Error("Expected manual approval");
      await expect(production.closeAgentPosition(next, paused)).rejects.toThrow("refused");
    } finally { db.close(); }
  });
});
