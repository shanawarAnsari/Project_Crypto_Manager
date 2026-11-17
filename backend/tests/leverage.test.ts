import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/persistence/database.js";
import { SqliteBotStateRepository, SqliteTradeRepository } from "../src/persistence/repositories.js";
import { RiskCore } from "../src/risk-core/risk-core.js";
import { applyAiDecision } from "../src/ai/apply-decision.js";
import { ExecutionService } from "../src/execution/execution-service.js";

describe("maximum 2x leverage policy", () => {
  it("defaults configuration to 2x, allows lower limits, and rejects higher limits", () => {
    expect(loadConfig({}).maxLeverage).toBe(2);
    expect(loadConfig({ MAX_LEVERAGE: "1.5" }).maxLeverage).toBe(1.5);
    expect(() => loadConfig({ MAX_LEVERAGE: "2.01" })).toThrow();
    expect(() => new RiskCore("100", 2.01)).toThrow("Leverage cap must be in (0, 2]");
  });

  it("rejects orders above 2x even with legacy persisted limits, while allowing lower leverage", () => {
    const db = createDatabase(":memory:");
    try {
      const state = new SqliteBotStateRepository(db).update({ enabled: true, maxLeverage: 3 });
      const risk = new RiskCore("1000", 2);
      const signal = {
        strategy: "meanReversion" as const, side: "buy" as const,
        referencePrice: "100", stopPrice: "99", confidence: 0.9, reason: "test"
      };
      expect(risk.approve(signal, state, 27, 2.01, "0", "0").approved).toBe(false);
      expect(risk.approve(signal, state, 27, 2, "0", "0").approved).toBe(true);
      expect(risk.approve(signal, state, 27, 1.5, "0", "0").approved).toBe(true);
    } finally {
      db.close();
    }
  });

  it("caps AI parameter application at 2x even with legacy configuration", () => {
    const db = createDatabase(":memory:");
    try {
      const state = new SqliteBotStateRepository(db);
      state.update({ maxLeverage: 3 });
      const decision = {
        strategy: "flat" as const,
        parameters: { maxLeverage: "3", riskPerTrade: "0.5", stopLoss: "1", riskRewardRatio: "2" },
        reasoning: "test"
      };
      expect(applyAiDecision(decision, state, 3).state.maxLeverage).toBe(2);
      state.update({ maxLeverage: 1.5 });
      expect(applyAiDecision(decision, state, 3).state.maxLeverage).toBe(1.5);
    } finally {
      db.close();
    }
  });

  it("refuses an approved order if the operator lowers the cap before submission", async () => {
    const db = createDatabase(":memory:");
    try {
      const state = new SqliteBotStateRepository(db).update({ enabled: true });
      const decision = new RiskCore("1000", 2).approve({
        strategy: "meanReversion", side: "buy", referencePrice: "100",
        stopPrice: "99", confidence: 0.9, reason: "test"
      }, state, 84, 2, "0", "0");
      expect(decision.approved).toBe(true);
      if (!decision.approved) throw new Error("Expected a valid 2x test approval");
      const placeOrder = vi.fn();
      const execution = new ExecutionService(new SqliteTradeRepository(db), { placeOrder }, loadConfig({}));
      await expect(execution.execute(decision.approval, { ...state, maxLeverage: 1.5 }))
        .rejects.toThrow("approved leverage exceeds configured limits");
      expect(placeOrder).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each([3, 1.5])("migrates a persisted %sx limit without raising lower limits", (previous) => {
    const folder = mkdtempSync(join(tmpdir(), "sunny-leverage-"));
    const path = join(folder, "test.sqlite");
    let db = createDatabase(path);
    try {
      expect(new SqliteBotStateRepository(db).get().maxLeverage).toBe(2);
      new SqliteBotStateRepository(db).update({ maxLeverage: previous, enabled: true });
      db.close();
      db = createDatabase(path);
      const state = new SqliteBotStateRepository(db).get();
      expect(state.maxLeverage).toBe(Math.min(previous, 2));
      if (previous > 2) expect(state.enabled).toBe(false);
    } finally {
      db.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
