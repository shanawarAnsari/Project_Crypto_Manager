import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { AgentCloseApproval, BotState, EmergencyCloseApproval, RiskApproval, TradingSignal } from "../domain.js";
import { DEMO_MAX_MARGIN_PERCENT, DEMO_MAX_PLANNED_LOSS_PERCENT, MAX_LEVERAGE, leverageCeiling } from "../domain.js";

const issuedApprovals = new WeakSet<object>();
const consumedApprovals = new WeakSet<object>();
const issuedEmergencyApprovals = new WeakSet<object>();
const consumedEmergencyApprovals = new WeakSet<object>();
const APPROVAL_MAX_AGE_MS = 30_000;
const closeApprovals = new WeakSet<object>();
const consumedCloseApprovals = new WeakSet<object>();

export interface AgentEntryInput {
  productId: number; side: "buy" | "sell"; entryPrice: string; stopPrice: string;
  takeProfitPrice: string; leverage: number; equity: string; availableMargin: string;
  realizedPnl: string; unrealizedPnl: string; feeRate: string; contractValue: string;
  tickSize: string; entryCount: number; marginPercent?: string;
  maxContracts?: number;
  exchangeMaxLeverage: string;
}

export type RiskDecision =
  | { approved: true; approval: RiskApproval }
  | { approved: false; reason: string };

export class RiskCore {
  private readonly maxDailyLoss: Decimal;
  constructor(
    maxDailyLoss: string,
    private readonly maxLeverage: number,
    private readonly environment: "production" | "testnet" = "production"
  ) {
    this.maxDailyLoss = new Decimal(maxDailyLoss);
    if (!this.maxDailyLoss.isFinite() || this.maxDailyLoss.lte(0)) throw new Error("Risk limit must be positive");
    const ceiling = leverageCeiling(environment);
    if (!Number.isFinite(maxLeverage) || maxLeverage <= 0 || maxLeverage > ceiling) throw new Error(`Leverage cap must be in (0, ${ceiling}]`);
  }

  dailyLossBreached(state: BotState, unrealizedPnl?: string, realizedPnl?: string): boolean {
    if (unrealizedPnl === undefined || realizedPnl === undefined) return true;
    try {
      const dailyPnl = new Decimal(realizedPnl).plus(unrealizedPnl);
      const dailyLossCap = Decimal.min(this.maxDailyLoss, new Decimal(state.maxDailyLoss));
      return !dailyPnl.isFinite() || !dailyLossCap.isFinite() || dailyLossCap.lte(0) ||
        dailyPnl.lte(dailyLossCap.neg());
    } catch {
      return true;
    }
  }

    approveAgentEntry(state: BotState, input: AgentEntryInput): RiskDecision {
      const reject = (reason: string): RiskDecision => ({ approved: false, reason });
      if (!state.enabled || state.killSwitch) return reject("Automation is paused or risk-locked");
      if (input.maxContracts !== undefined && (!Number.isSafeInteger(input.maxContracts) || input.maxContracts <= 0)) return reject("Invalid whole-contract cap");
      if (!Number.isInteger(input.entryCount) || input.entryCount < 0 || input.entryCount >= 5) return reject("Five-entry UTC daily limit reached");
      if (!Number.isSafeInteger(input.productId) || input.productId <= 0 ||
          !Number.isFinite(input.leverage) || input.leverage < 1 ||
          input.leverage > Math.min(this.maxLeverage, state.maxLeverage, leverageCeiling(this.environment))) return reject("Invalid product or leverage cap");
      if (this.dailyLossBreached(state, input.unrealizedPnl, input.realizedPnl)) return reject("UTC daily-loss circuit breaker is active");
      try {
        const entry = new Decimal(input.entryPrice);
        const fee = new Decimal(input.feeRate);
        const contract = new Decimal(input.contractValue);
        const tick = new Decimal(input.tickSize);
        const equity = new Decimal(input.equity);
        const available = new Decimal(input.availableMargin);
        const allocation = new Decimal(input.marginPercent ?? DEMO_MAX_MARGIN_PERCENT);
        const exchangeMaxLeverage = new Decimal(input.exchangeMaxLeverage);
        if (!exchangeMaxLeverage.isFinite() || exchangeMaxLeverage.lt(1) ||
            exchangeMaxLeverage.lt(input.leverage)) return reject("Requested leverage exceeds the verified exchange product cap");
        if (!allocation.isFinite() || allocation.lte(0) || allocation.gt(DEMO_MAX_MARGIN_PERCENT)) return reject(`Margin allocation exceeds ${DEMO_MAX_MARGIN_PERCENT}% of USD equity`);
        if ([entry, fee, contract, tick, equity, available].some((v) => !v.isFinite() || v.lte(0)) || fee.gt("0.02")) return reject("Account, contract or fee inputs are invalid");
        const stop = new Decimal(input.stopPrice).div(tick).toDecimalPlaces(0, input.side === "buy" ? Decimal.ROUND_UP : Decimal.ROUND_DOWN).mul(tick);
        const target = new Decimal(input.takeProfitPrice).div(tick).toDecimalPlaces(0, input.side === "buy" ? Decimal.ROUND_DOWN : Decimal.ROUND_UP).mul(tick);
        if ([stop, target].some((v) => !v.isFinite() || v.lte(0)) ||
            (input.side === "buy" ? stop.gte(entry) || target.lte(entry) : stop.lte(entry) || target.gte(entry))) return reject("Stop/target is on the wrong side of entry");
        const distance = entry.minus(stop).abs();
        const feesPerUnit = entry.plus(Decimal.max(entry, stop, target)).mul(fee);
        const marginPerUnit = entry.div(input.leverage);
        if (target.minus(entry).abs().lte(feesPerUnit)) return reject("Target does not cover estimated round-trip fees");
        const remaining = Decimal.min(this.maxDailyLoss, state.maxDailyLoss).plus(input.realizedPnl).plus(input.unrealizedPnl);
        const quantity = Decimal.min(
          equity.mul(allocation).div(100).div(marginPerUnit.plus(entry.mul(fee))),
          available.div(marginPerUnit.plus(entry.mul(fee))),
          remaining.div(distance.plus(feesPerUnit)),
          equity.mul(DEMO_MAX_PLANNED_LOSS_PERCENT).div(100).div(distance.plus(feesPerUnit)),
          input.maxContracts === undefined ? Infinity : contract.mul(input.maxContracts)
        ).div(contract).floor().mul(contract);
        if (!quantity.isFinite() || quantity.lte(0)) return reject("Approved size is below one whole exchange contract");
        const approval: RiskApproval = Object.freeze({ approvalId: randomUUID(), productId: input.productId,
          side: input.side, quantity: quantity.toString(), entryPrice: entry.toString(), leverage: input.leverage,
          stopPrice: stop.toString(), takeProfitPrice: target.toString(), issuedAt: Date.now() });
        issuedApprovals.add(approval);
        return { approved: true, approval };
      } catch {
        return reject("Invalid decimal risk inputs");
      }
    }

    approveAgentClose(state: BotState, productId: number, positionSide: "buy" | "sell", contracts: string,
      intent: AgentCloseApproval["intent"] = "agent-close"): AgentCloseApproval | null {
      if ((intent !== "agent-close" && intent !== "manual-owned-close") ||
          (intent === "agent-close" && (!state.enabled || state.killSwitch)) ||
          !Number.isSafeInteger(productId) || productId <= 0) return null;
      try {
        const size = new Decimal(contracts);
        if (!size.isFinite() || !size.isInteger() || size.lte(0)) return null;
      } catch { return null; }
      const approval: AgentCloseApproval = Object.freeze({ approvalId: randomUUID(), productId, intent,
        side: positionSide === "buy" ? "sell" : "buy", contracts, issuedAt: Date.now() });
      closeApprovals.add(approval);
      return approval;
    }

  approve(
    signal: TradingSignal,
    state: BotState,
    productId: number,
    requestedLeverage = 1,
    unrealizedPnl?: string,
    realizedPnl?: string
  ): RiskDecision {
    if (!state.enabled) return { approved: false, reason: "Bot is disabled" };
    if (state.killSwitch) return { approved: false, reason: "Kill switch is active" };
    if (!signal.side || !signal.stopPrice) return { approved: false, reason: "Signal has no valid entry or stop" };
    if (unrealizedPnl === undefined || realizedPnl === undefined) {
      return { approved: false, reason: "Account PnL reconciliation is required" };
    }
    const leverageCap = Math.min(this.maxLeverage, state.maxLeverage, MAX_LEVERAGE);
    if (!Number.isFinite(leverageCap) || leverageCap <= 0 ||
        !Number.isFinite(requestedLeverage) || requestedLeverage <= 0 || requestedLeverage > leverageCap) {
      return { approved: false, reason: "Requested leverage exceeds the configured cap" };
    }
    let dailyPnl: Decimal;
    let entry: Decimal;
    let stop: Decimal;
    let dailyLossCap: Decimal;
    let riskPercent: Decimal;
    let riskRewardRatio: Decimal;
    try {
      dailyPnl = new Decimal(realizedPnl).plus(unrealizedPnl);
      entry = new Decimal(signal.referencePrice);
      stop = new Decimal(signal.stopPrice);
      dailyLossCap = Decimal.min(this.maxDailyLoss, new Decimal(state.maxDailyLoss));
      riskPercent = new Decimal(state.riskPerTrade);
      riskRewardRatio = new Decimal(state.riskRewardRatio ?? "2");
    } catch {
      return { approved: false, reason: "Risk inputs are invalid" };
    }
    if (!dailyLossCap.isFinite() || dailyLossCap.lte(0) ||
        !riskPercent.isFinite() || riskPercent.lte(0) || riskPercent.gt(1) ||
        !riskRewardRatio.isFinite() || riskRewardRatio.lte(0) || riskRewardRatio.gt(5)) {
      return { approved: false, reason: "Persisted risk limits are invalid" };
    }
    if (!dailyPnl.isFinite() || dailyPnl.lte(dailyLossCap.neg())) {
      return { approved: false, reason: "UTC daily-loss circuit breaker is active" };
    }
    if (!entry.isFinite() || !stop.isFinite() || entry.lte(0)) return { approved: false, reason: "Entry price is invalid" };
    if ((signal.side === "buy" && stop.gte(entry)) || (signal.side === "sell" && stop.lte(entry))) {
      return { approved: false, reason: "Protective stop is on the wrong side of entry" };
    }
    const stopDistance = entry.minus(stop).abs();
    const takeProfit = signal.side === "buy"
      ? entry.plus(stopDistance.mul(riskRewardRatio))
      : entry.minus(stopDistance.mul(riskRewardRatio));
    const approvedTakeProfit = takeProfit.toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
    if (!approvedTakeProfit.isFinite() || approvedTakeProfit.lte(0) ||
        (signal.side === "buy" && approvedTakeProfit.lte(entry)) ||
        (signal.side === "sell" && approvedTakeProfit.gte(entry))) {
      return { approved: false, reason: "Calculated take-profit is invalid" };
    }
    const remainingLossBudget = dailyLossCap.plus(dailyPnl);
    const riskBudget = Decimal.min(dailyLossCap.mul(riskPercent).div(100), remainingLossBudget);
    if (riskBudget.lte(0)) return { approved: false, reason: "No daily loss budget remains" };
    const riskSizedQuantity = riskBudget.div(stopDistance);
    const leverageCappedQuantity = dailyLossCap.mul(requestedLeverage).div(entry);
    const quantity = Decimal.min(riskSizedQuantity, leverageCappedQuantity);
    if (!quantity.isFinite() || quantity.lte(0)) return { approved: false, reason: "Calculated quantity is invalid" };
    const approvedQuantity = quantity.toDecimalPlaces(8, Decimal.ROUND_DOWN);
    if (approvedQuantity.lte(0)) return { approved: false, reason: "Calculated quantity is below supported precision" };
    const approval: RiskApproval = Object.freeze({
      approvalId: randomUUID(),
      productId,
      side: signal.side,
      quantity: approvedQuantity.toString(),
      entryPrice: entry.toString(),
      leverage: requestedLeverage,
      stopPrice: stop.toString(),
      takeProfitPrice: approvedTakeProfit.toString(),
      issuedAt: Date.now()
    });
    issuedApprovals.add(approval);
    return { approved: true, approval };
  }

  approveEmergencyClose(state: BotState, productId: number): EmergencyCloseApproval | null {
    if (!state.killSwitch || state.enabled || !Number.isSafeInteger(productId) || productId <= 0) return null;
    const approval: EmergencyCloseApproval = Object.freeze({
      approvalId: randomUUID(),
      productId,
      intent: "emergency-close",
      issuedAt: Date.now()
    });
    issuedEmergencyApprovals.add(approval);
    return approval;
  }
}

export function consumeAgentCloseApproval(approval: AgentCloseApproval): boolean {
  if (!closeApprovals.has(approval) || consumedCloseApprovals.has(approval) ||
      Date.now() - approval.issuedAt < 0 || Date.now() - approval.issuedAt > APPROVAL_MAX_AGE_MS) return false;
  consumedCloseApprovals.add(approval);
  return true;
}

export function hasConsumedAgentCloseApproval(approval: AgentCloseApproval): boolean {
  return consumedCloseApprovals.has(approval) && Date.now() >= approval.issuedAt &&
    Date.now() - approval.issuedAt <= APPROVAL_MAX_AGE_MS;
}

export function consumeRiskApproval(approval: RiskApproval): boolean {
  if (!approval || !issuedApprovals.has(approval) || consumedApprovals.has(approval)) return false;
  const age = Date.now() - approval.issuedAt;
  if (age < 0 || age > APPROVAL_MAX_AGE_MS) return false;
  consumedApprovals.add(approval);
  return true;
}

export function hasConsumedRiskApproval(approval: RiskApproval): boolean {
  if (!approval || !issuedApprovals.has(approval) || !consumedApprovals.has(approval)) return false;
  const age = Date.now() - approval.issuedAt;
  return age >= 0 && age <= APPROVAL_MAX_AGE_MS;
}

export function consumeEmergencyCloseApproval(approval: EmergencyCloseApproval): boolean {
  if (!approval || !issuedEmergencyApprovals.has(approval) || consumedEmergencyApprovals.has(approval)) return false;
  const age = Date.now() - approval.issuedAt;
  if (age < 0 || age > APPROVAL_MAX_AGE_MS) return false;
  consumedEmergencyApprovals.add(approval);
  return true;
}

export function hasConsumedEmergencyCloseApproval(approval: EmergencyCloseApproval): boolean {
  if (!approval || !issuedEmergencyApprovals.has(approval) || !consumedEmergencyApprovals.has(approval)) return false;
  const age = Date.now() - approval.issuedAt;
  return age >= 0 && age <= APPROVAL_MAX_AGE_MS;
}
