import { describe, expect, it } from "vitest";
import { RiskCore } from "../src/risk-core/risk-core.js";
import type { BotState } from "../src/domain.js";
import Decimal from "decimal.js";

const state: BotState = { enabled: true, killSwitch: false, strategy: "flat", maxLeverage: 2,
  maxDailyLoss: "100", riskPerTrade: "0.5", stopLossPercent: "1", riskRewardRatio: "2", instruction: "", updatedAt: 0 };
const input = { productId: 84, side: "buy" as const, entryPrice: "100000", stopPrice: "99000",
  takeProfitPrice: "102000", leverage: 2, equity: "1000", availableMargin: "1000",
  realizedPnl: "0", unrealizedPnl: "0", feeRate: "0.00059", contractValue: "0.001", tickSize: "0.5", entryCount: 0,
  exchangeMaxLeverage: "200" };

describe("Demo agent risk policy", () => {
  it("defaults to at most 100% margin including the entry-fee reserve", () => {
    const result = new RiskCore("1000", 2).approveAgentEntry(state, input);
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.approval.quantity).toBe("0.019");
    const costPerUnit = new Decimal(input.entryPrice).div(input.leverage).plus(new Decimal(input.entryPrice).mul(input.feeRate));
    const cost = new Decimal(result.approval.quantity).mul(costPerUnit);
    expect(cost.lte(input.equity)).toBe(true);
    expect(cost.plus(new Decimal(input.contractValue).mul(costPerUnit)).gt(input.equity)).toBe(true);
    expect(result.approval.leverage).toBe(2);
  });
  it.each(["25", "40"])("preserves valid explicit allocation %s", (marginPercent) => {
    const result = new RiskCore("1000", 2).approveAgentEntry(state, { ...input, marginPercent });
    expect(result.approved && result.approval.quantity).toBe(marginPercent === "25" ? "0.004" : "0.007");
  });
  it.each(["100.00001", "101", "0", "-1", "NaN"])("rejects allocation outside (0,100]: %s", (marginPercent) => {
    const result = new RiskCore("1000", 2).approveAgentEntry(state, { ...input, marginPercent });
    expect(result).toEqual({ approved: false, reason: "Margin allocation exceeds 100% of USD equity" });
  });
  it("admits one 1x contract for the reported Demo balance at 40%, not 25%", () => {
    const risk = new RiskCore("1000", 2);
    const test = { ...input, entryPrice: "64027.5", stopPrice: "63387.2", takeProfitPrice: "65308.1",
      tickSize: "0.1", equity: "198.21553076", availableMargin: "198.21553076", leverage: 1, maxContracts: 1 };
    expect(risk.approveAgentEntry(state, { ...test, marginPercent: "25" }).approved).toBe(false);
    const result = risk.approveAgentEntry(state, { ...test, marginPercent: "40" });
    expect(result.approved && result.approval.quantity).toBe("0.001");
    expect(risk.approveAgentEntry(state, { ...test, availableMargin: "60" }).approved).toBe(false);
    expect(risk.approveAgentEntry({ ...state, maxDailyLoss: "0.1" }, test).approved).toBe(false);
  });
  it.each([
    { entryCount: 5 }, { stopPrice: "0" }, { feeRate: "0" },
    { availableMargin: "0" }, { leverage: 3 }, { realizedPnl: "-100" },
    { equity: "NaN" }, { contractValue: "100" }, { takeProfitPrice: "100010" }
  ])("rejects invalid/unsafe policy inputs %j", (patch) => {
    expect(new RiskCore("1000", 2).approveAgentEntry(state, { ...input, ...patch }).approved).toBe(false);
  });
  it("fails closed while paused and respects lower leverage limits", () => {
    const risk = new RiskCore("1000", 2);
    expect(risk.approveAgentEntry({ ...state, enabled: false }, input).approved).toBe(false);
    expect(risk.approveAgentEntry({ ...state, maxLeverage: 1 }, input).approved).toBe(false);
  });
  it("caps a test entry at one contract without raising the affordable size", () => {
    const risk = new RiskCore("1000", 2);
    const result = risk.approveAgentEntry(state, { ...input, maxContracts: 1 });
    expect(result.approved && result.approval.quantity).toBe("0.001");
    expect(risk.approveAgentEntry(state, { ...input, maxContracts: 1, availableMargin: "1" }).approved).toBe(false);
  });
  it.each([0, -1, 1.5, NaN, Infinity])("rejects an invalid contract cap %s", (maxContracts) => {
    expect(new RiskCore("1000", 2).approveAgentEntry(state, { ...input, maxContracts }).approved).toBe(false);
  });
  it("permits 100x Demo but not Live, lower operator caps or unsupported product leverage", () => {
    const high = { ...input, leverage: 100, exchangeMaxLeverage: "200" };
    const highState = { ...state, maxLeverage: 100 };
    const demo = new RiskCore("10000", 100, "testnet");
    expect(demo.approveAgentEntry(highState, high).approved).toBe(true);
    expect(demo.approveAgentEntry({ ...highState, maxLeverage: 2 }, high).approved).toBe(false);
    expect(demo.approveAgentEntry(highState, { ...high, exchangeMaxLeverage: "50" }).approved).toBe(false);
    expect(demo.approveAgentEntry(highState, { ...high, leverage: 100.01 }).approved).toBe(false);
    expect(new RiskCore("10000", 2).approveAgentEntry(highState, high).approved).toBe(false);
  });
  it("sizes at the exact 30%-of-total-equity planned-loss boundary including fees", () => {
    const high = { ...input, leverage: 100, equity: "1000", availableMargin: "1000",
      stopPrice: "90000", takeProfitPrice: "120000", exchangeMaxLeverage: "200" };
    const result = new RiskCore("10000", 100, "testnet").approveAgentEntry({ ...state, maxLeverage: 100, maxDailyLoss: "500" }, high);
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    const perUnit = new Decimal(10000).plus(new Decimal(220000).mul(high.feeRate));
    const loss = new Decimal(result.approval.quantity).mul(perUnit);
    expect(loss.lte("300")).toBe(true);
    expect(loss.plus(perUnit.mul(high.contractValue)).gt("300")).toBe(true);
  });
});
