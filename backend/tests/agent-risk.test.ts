import { describe, expect, it } from "vitest";
import { RiskCore } from "../src/risk-core/risk-core.js";
import type { BotState } from "../src/domain.js";

const state: BotState = { enabled: true, killSwitch: false, strategy: "flat", maxLeverage: 2,
  maxDailyLoss: "100", riskPerTrade: "0.5", stopLossPercent: "1", riskRewardRatio: "2", instruction: "", updatedAt: 0 };
const input = { productId: 84, side: "buy" as const, entryPrice: "100000", stopPrice: "99000",
  takeProfitPrice: "102000", leverage: 2, equity: "1000", availableMargin: "1000",
  realizedPnl: "0", unrealizedPnl: "0", feeRate: "0.00059", contractValue: "0.001", tickSize: "0.5", entryCount: 0 };

describe("Demo agent risk policy", () => {
  it("allocates at most 25% margin and includes tax-inclusive fees in planned loss", () => {
    const result = new RiskCore("1000", 2).approveAgentEntry(state, input);
    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.approval.quantity).toBe("0.004");
    expect(result.approval.leverage).toBe(2);
  });
  it.each([
    { entryCount: 5 }, { stopPrice: "96000" }, { feeRate: "0" },
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
});
