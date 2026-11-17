import Decimal from "decimal.js";
import type { AiDecision } from "./decision-service.js";
import type { BotStateRepository } from "../persistence/repositories.js";
import { MAX_LEVERAGE } from "../domain.js";

export function applyAiDecision(
  decision: AiDecision,
  botState: BotStateRepository,
  hardLeverageCap: number
) {
  const current = botState.get();
  const leverage = Decimal.min(decision.parameters.maxLeverage, current.maxLeverage, hardLeverageCap, MAX_LEVERAGE);
  const riskPerTrade = Decimal.min(decision.parameters.riskPerTrade, current.riskPerTrade);
  const stopLoss = Decimal.min(decision.parameters.stopLoss, current.stopLossPercent);
  const riskRewardRatio = Decimal.min(decision.parameters.riskRewardRatio, current.riskRewardRatio ?? "2");
  if ([leverage, riskPerTrade, stopLoss, riskRewardRatio].some((value) => !value.isFinite() || value.lte(0))) {
    throw new Error("AI parameter application failed closed because persisted risk settings are invalid");
  }
  const state = botState.update({
    strategy: decision.strategy,
    maxLeverage: leverage.toNumber(),
    riskPerTrade: riskPerTrade.toString(),
    stopLossPercent: stopLoss.toString(),
    riskRewardRatio: riskRewardRatio.toString()
  });
  return {
    state,
    parameters: {
      maxLeverage: leverage.toString(),
      riskPerTrade: riskPerTrade.toString(),
      stopLoss: stopLoss.toString(),
      riskRewardRatio: riskRewardRatio.toString()
    }
  };
}
