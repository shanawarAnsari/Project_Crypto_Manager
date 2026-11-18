import Decimal from "decimal.js";
import type { AgentCloseApproval, BotState, EmergencyCloseApproval, RiskApproval } from "../domain.js";
import { leverageCeiling } from "../domain.js";
import type { TradeRepository } from "../persistence/repositories.js";
import { consumeAgentCloseApproval, consumeEmergencyCloseApproval, consumeRiskApproval } from "../risk-core/risk-core.js";
import type { TestnetOrderGateway } from "./delta-order-gateway.js";
import type { AppConfig } from "../config.js";

export class ExecutionService {
  constructor(
    private readonly trades: TradeRepository,
    private readonly orderGateway: TestnetOrderGateway,
    private readonly config: AppConfig
  ) {}

  async closeAgentPosition(approval: AgentCloseApproval, state: BotState): Promise<void> {
    if (this.config.deltaEnvironment !== "testnet" ||
        (approval.intent !== "manual-owned-close" && (!state.enabled || state.killSwitch)) ||
        approval.productId !== this.config.deltaProductId || !consumeAgentCloseApproval(approval) ||
        !this.orderGateway.closeAgentPosition) {
      throw new Error("Demo agent close was refused by execution");
    }
    await this.orderGateway.closeAgentPosition(approval);
  }

  async execute(approval: RiskApproval, state: BotState): Promise<{ id: number; status: string }> {
    if (!approval || typeof approval.quantity !== "string") {
      throw new Error("Execution refused: approved quantity is invalid");
    }
    let quantity: Decimal;
    let entryPrice: Decimal;
    let takeProfitPrice: Decimal;
    try {
      quantity = new Decimal(approval.quantity);
      entryPrice = new Decimal(approval.entryPrice);
      takeProfitPrice = new Decimal(approval.takeProfitPrice);
    } catch {
      throw new Error("Execution refused: approved order values are invalid");
    }
    if (!quantity.isFinite() || quantity.lte(0) || !entryPrice.isFinite() || entryPrice.lte(0) ||
        !takeProfitPrice.isFinite() || takeProfitPrice.lte(0) ||
        (approval.side === "buy" && takeProfitPrice.lte(entryPrice)) ||
        (approval.side === "sell" && takeProfitPrice.gte(entryPrice))) {
      throw new Error("Execution refused: approved order values are invalid");
    }
    if (!consumeRiskApproval(approval)) throw new Error("A fresh RiskApproval is required for execution");
    if (!state.enabled || state.killSwitch) throw new Error("Execution refused: bot is disabled or kill switch is active");
    if (approval.productId !== this.config.deltaProductId) throw new Error("Execution refused: approved product does not match configured product");
    if (!Number.isFinite(approval.leverage) || approval.leverage <= 0 ||
        approval.leverage > Math.min(this.config.maxLeverage, state.maxLeverage, leverageCeiling(this.config.deltaEnvironment))) {
      throw new Error("Execution refused: approved leverage exceeds configured limits");
    }
    if (this.trades.hasPendingSubmission(approval.productId)) {
      throw new Error("Execution refused: an unresolved order submission already exists for this product");
    }
    if (this.config.deltaEnvironment === "production" && !this.config.liveTradingConfirmed) {
      throw new Error("Order placement is unavailable: live trading has not been confirmed");
    }
    if (!this.config.deltaApiKey || !this.config.deltaApiSecret) {
      throw new Error("Order placement is unavailable: Delta credentials are required");
    }
    if (!approval.stopPrice || !approval.takeProfitPrice) {
      throw new Error("Execution refused: exchange-side stop-loss and take-profit brackets are mandatory");
    }
    const clientOrderId = approval.approvalId.replaceAll("-", "");
    const id = this.trades.record({
      productId: approval.productId,
      side: approval.side,
      status: "submitting",
      quantity: approval.quantity,
      price: entryPrice.toString(),
      stopPrice: approval.stopPrice,
      takeProfitPrice: approval.takeProfitPrice,
      leverage: String(approval.leverage),
      clientOrderId
    });
    try {
      await this.orderGateway.placeOrder({
        productId: approval.productId,
        side: approval.side,
        quantity: approval.quantity,
        leverage: approval.leverage,
        stopPrice: approval.stopPrice,
        takeProfitPrice: approval.takeProfitPrice,
        clientOrderId
      }, approval);
    } catch {
      this.trades.updateSubmissionStatus(id, "submission_unknown");
      throw new Error("Order submission is uncertain; automatic retry is disabled");
    }
    this.trades.updateSubmissionStatus(id, "submitted");
    return { id, status: "submitted" };
  }

  async emergencyHalt(
    approval: EmergencyCloseApproval,
    state: BotState
  ): Promise<{
    cancelOrders: "succeeded" | "failed" | "unconfirmed";
    closePositions: "succeeded" | "failed" | "unconfirmed";
  }> {
    if (!consumeEmergencyCloseApproval(approval)) {
      throw new Error("A fresh emergency close RiskApproval is required");
    }
    if (
      !state.killSwitch || state.enabled || !this.config.deltaApiKey || !this.config.deltaApiSecret ||
      approval.productId !== this.config.deltaProductId
    ) {
      throw new Error("Emergency exchange actions require a latched kill switch and Delta credentials");
    }
    if (!this.orderGateway.cancelAllOrders || !this.orderGateway.closeAllPositions) {
      throw new Error("Emergency exchange actions are unavailable in the configured order gateway");
    }
    const confirmationStatus = async (
      verify: ((productId: number) => Promise<boolean>) | undefined
    ): Promise<"succeeded" | "failed" | "unconfirmed"> => {
      if (!verify) return "unconfirmed";
      const [result] = await Promise.allSettled([verify(approval.productId)]);
      return result.status === "rejected" ? "unconfirmed" : result.value ? "succeeded" : "failed";
    };

    await Promise.allSettled([this.orderGateway.cancelAllOrders(approval.productId, approval)]);
    const cancelOrders = await confirmationStatus(this.orderGateway.confirmNoOpenOrders?.bind(this.orderGateway));
    if (cancelOrders !== "succeeded") {
      return {
        cancelOrders,
        closePositions: await confirmationStatus(this.orderGateway.confirmNoOpenPositions?.bind(this.orderGateway))
      };
    }

    await Promise.allSettled([this.orderGateway.closeAllPositions(approval.productId, approval)]);
    return {
      cancelOrders: await confirmationStatus(this.orderGateway.confirmNoOpenOrders?.bind(this.orderGateway)),
      closePositions: await confirmationStatus(this.orderGateway.confirmNoOpenPositions?.bind(this.orderGateway))
    };
  }

}
