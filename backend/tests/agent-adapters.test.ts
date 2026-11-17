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
      symbol: "ETHUSD", live: true, contractValue: "0.001", tickSize: "0.5"
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
});
