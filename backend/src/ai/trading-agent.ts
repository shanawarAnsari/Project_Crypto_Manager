import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { AppServices } from "../services.js";
import type { RiskApproval } from "../domain.js";
import { syncDailyLossCap } from "../services.js";
import { DEMO_MAX_MARGIN_PERCENT, DEMO_MAX_LEVERAGE, DEMO_MAX_PLANNED_LOSS_PERCENT, DEMO_DAILY_LOSS_PERCENT, TIMEFRAME_SECONDS } from "../domain.js";
import { DeltaApiError, type DeltaAccountRiskSnapshot, type DeltaAgentOrder } from "../exchange/delta-client.js";
import { AgentRepository } from "./agent-repository.js";
import type { AgentModel } from "./agent-model.js";
import type { AgentDecision, AgentSnapshot, AgentTimeframe, AgentTrade, DemoTestEntryPreview } from "./agent-types.js";

type EntryProposal = Extract<AgentDecision, { action: "open" }>;

export class TradingAgent {
  private busy = false;
  private closingAll = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private pending: Promise<unknown> | null = null;
  private testPreview: { preview: DemoTestEntryPreview; decision: EntryProposal; revision: number } | null = null;
  constructor(
    private readonly services: AppServices,
    readonly repository: AgentRepository,
    private readonly model: AgentModel,
    private readonly now: () => number = Date.now
  ) {}

  snapshot(): AgentSnapshot {
    const settings = this.repository.settings();
    const period = TIMEFRAME_SECONDS[settings.timeframe] * 1000;
    return { timeframe: settings.timeframe, model: this.services.config.aiModel,
      configured: this.model.configured, busy: this.busy || this.closingAll, enabled: this.services.botState.get().enabled,
      demoOnly: true, lastReviewAt: settings.lastReviewAt,
      nextReviewAt: this.services.botState.get().enabled ? (Math.floor(this.now() / period) + 1) * period : null,
      trade: this.repository.activeTrade(), events: this.repository.events() };
  }
  start(): void {
    this.stopped = false;
    this.repository.event("activity", "Agent ready. Automation is paused after restart; press Start for Demo reviews.");
    this.timer = setInterval(() => { void this.tick(); }, 5000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.repository.invalidate();
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([this.pending]);
  }
  invalidate(): void { this.repository.invalidate(); }
  setTimeframe(timeframe: AgentTimeframe): AgentSnapshot {
    this.services.botState.update({ enabled: false });
    this.repository.setTimeframe(timeframe);
    this.repository.event("activity", `Review interval and candles changed to ${timeframe}. Automation paused; press Start to resume.`);
    return this.snapshot();
  }
  send(message: string): void {
    if (this.busy || this.closingAll) throw new Error("Agent is busy; wait for the current review to finish");
    if (!this.model.configured) throw new Error("NVIDIA API key is not configured");
    this.repository.invalidate();
    this.repository.event("user", message);
    this.pending = this.review(true);
  }
  async tick(): Promise<void> {
    if (this.busy || this.closingAll || this.stopped || !this.services.botState.get().enabled) return;
    this.pending = this.review(false);
    await this.pending;
  }
  private assertTestReady(revision: number): void {
    const { config, botState } = this.services;
    if (config.deltaEnvironment !== "testnet") throw new Error("Test entry is Demo-only");
    if (this.stopped || revision !== this.repository.settings().revision) throw new Error("Controls changed; request a new test preview");
    const state = botState.get();
    if (!state.enabled || state.killSwitch) throw new Error("Start an unlocked Demo bot before requesting a test entry");
    if (!config.deltaApiKey || !config.deltaApiSecret) throw new Error("Demo credentials are unavailable");
  }
  private async testOperation<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy || this.closingAll) throw new Error("Agent is busy; wait for the current operation to finish");
    this.busy = true;
    const work = action();
    this.pending = work;
    try { return await work; }
    catch (error) {
      this.repository.event("error", error instanceof Error ? error.message : "Demo test entry failed");
      throw error;
    } finally { this.busy = false; }
  }
  get safetyActionInProgress(): boolean { return this.closingAll; }

  async closeAllDemoPositions(): Promise<void> {
    const { services } = this;
    if (services.config.deltaEnvironment !== "testnet") throw new Error("Close all positions is Demo-only");
    if (this.closingAll) throw new Error("A Demo close-all action is already in progress");
    if (this.stopped) throw new Error("Trading agent is stopped");
    if (!services.config.deltaApiKey || !services.config.deltaApiSecret) throw new Error("Demo credentials are unavailable");
    this.closingAll = true;
    this.testPreview = null;
    this.invalidate();
    this.repository.event("activity", "Operator confirmed closing app-owned Demo BTCUSD trades only. External positions/orders are excluded; automation controls will be preserved on verified success.");
    const previous = this.pending;
    const work = (async () => {
      await Promise.allSettled([previous]);
      if (this.stopped || services.config.deltaEnvironment !== "testnet") throw new Error("Demo close-all aborted because runtime controls changed");
      const revision = this.repository.settings().revision;
      if (services.trades.hasPendingSubmission(services.config.deltaProductId)) {
        throw new Error("An unresolved submission requires reconciliation before closing app-owned trades");
      }
      const account = await services.delta.getAccountRiskSnapshot();
      const trade = await this.reconcile(account);
      if (this.stopped || revision !== this.repository.settings().revision ||
          services.config.deltaEnvironment !== "testnet") throw new Error("Demo close aborted because runtime controls changed");
      if (!trade) {
        this.repository.event("activity", "No app-owned Demo BTCUSD trade to close. External positions/orders and automation controls were left unchanged.");
        return;
      }
      if (trade.status !== "open") throw new Error("No confirmed app-owned open trade is available; pending exits will not be retried");
      await this.closeOwnedTrade(trade, "manual-owned-close");
      if (this.repository.activeTrade()) throw new Error("App-owned Demo exit not confirmed; inspect Delta Demo");
      this.repository.event("activity", "App-owned Demo BTCUSD exit confirmed. Automation controls are unchanged; running automation continues on its normal schedule and may trade again on a later valid signal.");
    })();
    this.pending = work;
    try { await work; }
    catch (error) {
      const message = `${error instanceof Error ? error.message : "Demo owned close failed; inspect exchange exposure"}. Automation is paused and risk-locked; no automatic retry.`;
      this.halt(message);
      throw new Error(message);
    } finally { this.closingAll = false; }
  }
  private async closeOwnedTrade(trade: AgentTrade, intent: "agent-close" | "manual-owned-close" = "agent-close"): Promise<void> {
    const { services } = this;
    const approval = services.risk.approveAgentClose(services.botState.get(), services.config.deltaProductId,
      trade.side, trade.contracts, intent);
    if (!approval) throw new Error("Risk core refused the owned close");
    const pending: AgentTrade = { ...trade, status: "exit_pending", exitRequestedAt: this.now(),
      closeClientOrderId: approval.approvalId.replaceAll("-", "") };
    this.repository.saveTrade(pending);
    this.repository.event("activity", "Risk-approved reduce-only Demo exit is being submitted.");
    await services.execution.closeAgentPosition(approval, services.botState.get());
    this.repository.event("activity", "Exit submission acknowledged. Checking exchange read-back; the position is not yet confirmed closed.");
    await this.reconcile(await services.delta.getAccountRiskSnapshot());
  }
  async previewTestEntry(side: "buy" | "sell", leverage = 1): Promise<DemoTestEntryPreview> {
    return this.testOperation(async () => {
      this.testPreview = null;
      const revision = this.repository.settings().revision;
      this.assertTestReady(revision);
      if (side !== "buy" && side !== "sell") throw new Error("Invalid test entry side");
      if (!Number.isInteger(leverage) || leverage < 1 || leverage > DEMO_MAX_LEVERAGE) throw new Error("Test entry leverage must be a whole number from 1 to 100");
      const ticker = await this.services.delta.getTicker("BTCUSD");
      const price = new Decimal(ticker.price);
      const decision: EntryProposal = { action: "open", side, marginPercent: String(DEMO_MAX_MARGIN_PERCENT), leverage,
        stopPrice: price.mul(side === "buy" ? "0.99" : "1.01").toString(),
        takeProfitPrice: price.mul(side === "buy" ? "1.02" : "0.98").toString(),
        summary: "Operator-confirmed Demo execution test; no strategy signal." };
      const prepared = await this.prepareEntry(decision, 1, true);
      this.assertTestReady(revision);
      if (!prepared.result.approved) throw new Error(`Test entry refused: ${prepared.result.reason}`);
      const approval = prepared.result.approval;
      const preview: DemoTestEntryPreview = { token: randomUUID(), expiresAt: this.now() + 30_000,
        side, contracts: new Decimal(approval.quantity).div(prepared.contractValue).toString(),
        entryPrice: approval.entryPrice, stopPrice: approval.stopPrice, takeProfitPrice: approval.takeProfitPrice,
        leverage: approval.leverage };
      this.testPreview = { preview, decision: { ...decision, stopPrice: approval.stopPrice, takeProfitPrice: approval.takeProfitPrice }, revision };
      this.repository.event("activity", `Demo test preview: ${side.toUpperCase()}, ${preview.contracts} contract at ${preview.leverage}x, stop ${preview.stopPrice}, target ${preview.takeProfitPrice}. No order submitted; explicit confirmation expires in 30 seconds.`);
      return preview;
    });
  }
  async confirmTestEntry(token: string): Promise<void> {
    return this.testOperation(async () => {
      const saved = this.testPreview;
      this.testPreview = null;
      if (!saved || saved.preview.token !== token || this.now() >= saved.preview.expiresAt) {
        throw new Error("Test confirmation is invalid, expired or already used; request a new preview");
      }
      this.assertTestReady(saved.revision);
      const prepared = await this.prepareEntry(saved.decision, 1);
      this.assertTestReady(saved.revision);
      if (this.now() >= saved.preview.expiresAt) throw new Error("Test confirmation expired during validation");
      if (!prepared.result.approved) throw new Error(`Test entry refused: ${prepared.result.reason}`);
      if (prepared.result.approval.leverage !== saved.preview.leverage) {
        throw new Error("Test leverage changed; request a new preview");
      }
      if (!new Decimal(prepared.result.approval.quantity).div(prepared.contractValue).eq(saved.preview.contracts)) {
        throw new Error("Test contract size changed; request a new preview");
      }
      if (prepared.result.approval.stopPrice !== saved.preview.stopPrice ||
          prepared.result.approval.takeProfitPrice !== saved.preview.takeProfitPrice) {
        throw new Error("Test bracket prices changed; request a new preview");
      }
      this.repository.event("activity", "Operator explicitly confirmed a Demo test entry. Fresh risk checks passed; no strategy signal was used.");
      try {
        await this.submitEntry(prepared.result.approval, prepared.contractValue, saved.decision.summary);
      } catch (error) {
        this.halt(error instanceof Error ? error.message : "Demo test submission or read-back failed");
        throw error;
      }
    });
  }
  private async prepareEntry(decision: EntryProposal, maxContracts?: number, testPreview = false) {
    const { services } = this;
    const account = await services.delta.getAccountRiskSnapshot();
    syncDailyLossCap(services, account);
    const trade = await this.reconcile(account);
    if (trade || account.positions.length || account.openOrders.length || services.trades.hasPendingSubmission(services.config.deltaProductId)) {
      throw new Error("Existing exposure, orders or an unresolved submission blocks a new entry");
    }
    const [spec, feeRate, ticker] = await Promise.all([
      services.delta.getProductSpec(), services.delta.getAgentFeeRate(), services.delta.getTicker("BTCUSD")
    ]);
    if (!spec.live) throw new Error("BTCUSD is not operational");
    let stopPrice = decision.stopPrice;
    let takeProfitPrice = decision.takeProfitPrice;
    if (testPreview) {
      const price = new Decimal(ticker.price);
      const contract = new Decimal(spec.contractValue);
      const fee = new Decimal(feeRate);
      const state = services.botState.get();
      const remaining = Decimal.min(services.config.maxDailyLoss, state.maxDailyLoss)
        .plus(account.realizedPnl).plus(account.unrealizedPnl);
      const budget = Decimal.min(new Decimal(account.equity).mul(DEMO_MAX_PLANNED_LOSS_PERCENT).div(100), remaining);
      const fraction = Decimal.min("0.01", budget.div(price.mul(contract)).minus(fee.mul(2))
        .div(new Decimal(1).plus(fee.mul(2))).mul("0.99"));
      if (!fraction.isFinite() || fraction.lte(0)) throw new Error("Test planned-loss budget cannot cover fees and a safe stop");
      stopPrice = price.mul(new Decimal(1).plus(fraction.mul(decision.side === "buy" ? -1 : 1))).toString();
      takeProfitPrice = price.mul(new Decimal(1).plus(fraction.mul(decision.side === "buy" ? 2 : -2))).toString();
    }
    const result = services.risk.approveAgentEntry(services.botState.get(), {
      productId: services.config.deltaProductId, side: decision.side, entryPrice: ticker.price,
      stopPrice, takeProfitPrice, leverage: decision.leverage, exchangeMaxLeverage: spec.maxLeverage,
      equity: account.equity, availableMargin: account.availableMargin, realizedPnl: account.realizedPnl,
      unrealizedPnl: account.unrealizedPnl, feeRate, contractValue: spec.contractValue, tickSize: spec.tickSize,
      entryCount: this.repository.entryCount(this.now()), marginPercent: decision.marginPercent,
      ...(maxContracts === undefined ? {} : { maxContracts })
    });
    return { result, contractValue: spec.contractValue };
  }
  private async submitEntry(approval: RiskApproval, contractValue: string, thesis: string): Promise<void> {
    const { services } = this;
    const pending: AgentTrade = { id: randomUUID(), clientOrderId: approval.approvalId.replaceAll("-", ""),
      closeClientOrderId: null, side: approval.side, contracts: new Decimal(approval.quantity).div(contractValue).toString(),
      entryPrice: approval.entryPrice, stopPrice: approval.stopPrice, takeProfitPrice: approval.takeProfitPrice,
      thesis, status: "entry_pending", createdAt: this.now() };
    this.repository.saveTrade(pending);
    this.repository.event("activity", `Risk approved ${approval.side.toUpperCase()}: ${pending.contracts} contracts, stop ${approval.stopPrice}, target ${approval.takeProfitPrice}. Submitting Demo order with estimated tax-inclusive fees.`);
    await services.execution.execute(approval, services.botState.get());
    this.repository.event("activity", "Entry submission acknowledged. Checking exchange read-back for fill and stop/target protection; submission alone is not a confirmed fill.");
    await this.reconcile(await services.delta.getAccountRiskSnapshot());
  }
  private halt(message: string): void {
    this.services.botState.update({ enabled: false, killSwitch: true });
    this.services.status.set("risk_status", "agent_locked");
    this.services.status.set("risk_halt_reason", message);
    this.repository.event("error", message);
  }
  private verifyOwnedPosition(trade: AgentTrade, order: DeltaAgentOrder, positions: DeltaAccountRiskSnapshot["positions"]): void {
    const position = positions[0];
    if (order.productId !== this.services.config.deltaProductId || order.side !== trade.side || order.contracts !== trade.contracts ||
        order.state !== "closed" || !new Decimal(order.unfilledContracts).isZero() ||
        positions.length !== 1 || !position || position.side !== trade.side ||
        !new Decimal(position.quantity).eq(trade.contracts) || !new Decimal(position.entryPrice).eq(order.averageFillPrice)) {
      throw new DeltaApiError("Position ownership/size changed; the agent will not manage external exposure", 502);
    }
    if (trade.status !== "exit_pending" && (order.stopPrice !== trade.stopPrice || order.takeProfitPrice !== trade.takeProfitPrice)) {
      throw new DeltaApiError("Exchange bracket protection could not be reconciled; inspect the position and use emergency controls if needed", 502);
    }
  }
  async verifiedPositionProtection(account: DeltaAccountRiskSnapshot): Promise<{ productId: number; stopPrice: string; takeProfitPrice: string } | null> {
    const trade = this.repository.activeTrade();
    const positions = account.positions.filter((position) => position.productId === this.services.config.deltaProductId);
    if (!trade || trade.status !== "open" || !positions.length) return null;
    const order = await this.services.delta.getAgentOrder(trade.clientOrderId);
    this.verifyOwnedPosition(trade, order, positions);
    return { productId: this.services.config.deltaProductId, stopPrice: trade.stopPrice, takeProfitPrice: trade.takeProfitPrice };
  }
  private async reconcile(account: DeltaAccountRiskSnapshot): Promise<AgentTrade | null> {
    const trade = this.repository.activeTrade();
    if (!trade) return null;
    if (trade.status === "blocked") throw new Error("An unresolved agent trade requires operator reconciliation");
    const order = await this.services.delta.getAgentOrder(trade.clientOrderId);
    if (order.side !== trade.side || order.contracts !== trade.contracts) throw new Error("Entry order differs from the saved trade");
    this.services.trades.confirmSubmission(trade.clientOrderId);
    const positions = account.positions.filter((p) => p.productId === this.services.config.deltaProductId);
    const orders = account.openOrders.filter((o) => o.productId === this.services.config.deltaProductId);
    if (!order.unfilledContracts || !new Decimal(order.unfilledContracts).isZero() || order.state !== "closed") {
      if (this.now() - trade.createdAt > 60_000) throw new Error("Entry has not fully filled; automatic action is blocked");
      this.repository.event("activity", "Entry is awaiting a confirmed complete fill; no additional order will be submitted.");
      return trade;
    }
    if (!positions.length) {
      if (orders.length) throw new Error("Position is flat but working orders remain; use the safety controls to reconcile them");
      if (trade.status === "exit_pending" && trade.closeClientOrderId) {
        const close = await this.services.delta.getAgentOrder(trade.closeClientOrderId);
        if (close.productId !== this.services.config.deltaProductId ||
            close.state !== "closed" || close.unfilledContracts !== "0" || close.contracts !== trade.contracts ||
            close.side === trade.side) throw new Error("Agent exit has not been confirmed");
      }
      this.repository.saveTrade({ ...trade, status: "closed" });
      this.repository.event("activity", `Trade ${trade.id.slice(0, 8)} is confirmed flat with no working orders. Daily ledger includes actual trading charges.`);
      return null;
    }
    this.verifyOwnedPosition(trade, order, positions);
    if (trade.status === "exit_pending") {
      if (this.now() - (trade.exitRequestedAt ?? trade.createdAt) > 60_000) throw new Error("Exit is still pending; duplicate closing orders are prohibited");
      return trade;
    }
    const opened: AgentTrade = { ...trade, entryPrice: order.averageFillPrice, status: "open" };
    if (trade.status !== "open") this.repository.event("activity", `Entry fill confirmed. ${trade.contracts} contracts; reported entry commission ${order.paidCommission} USD (daily ledger is authoritative).`);
    this.repository.saveTrade(opened);
    return opened;
  }
  private async review(chatOnly: boolean): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    const settings = this.repository.settings();
    const started = this.now();
    try {
      const { services } = this;
      if (!chatOnly && services.config.deltaEnvironment !== "testnet") throw new Error("Autonomous agent execution is Demo-only");
      if (!this.model.configured) throw new Error("NVIDIA API key is not configured");
      const period = TIMEFRAME_SECONDS[settings.timeframe] * 1000;
      const expectedCandle = Math.floor(started / period) * period - period;
      const candleKey = `${settings.timeframe}:${expectedCandle}`;
      if (!chatOnly && settings.lastCandle === candleKey) {
        // Continue reconciliation and daily risk monitoring between opportunity reviews.
        const account = await services.delta.getAccountRiskSnapshot();
        const state = syncDailyLossCap(services, account);
        if (services.risk.dailyLossBreached(state, account.unrealizedPnl, account.realizedPnl)) throw new Error("UTC daily-loss cap reached");
        await this.reconcile(account);
        return;
      }
      if (!chatOnly && !this.repository.markReview(candleKey, started)) return;
      this.repository.event("activity", `Checking closed ${settings.timeframe} candles and account context${chatOnly ? " for your message (no order)" : ""}.`);
      const candles = (await services.delta.getCandles(settings.timeframe, "BTCUSD", 100))
        .filter((c) => c.timestamp + period <= this.now());
      const latest = candles.at(-1);
      if (candles.length < 20 || !latest || latest.timestamp !== expectedCandle) throw new Error("Fresh completed market candles are unavailable");
      let account: DeltaAccountRiskSnapshot | null = null;
      let trade: AgentTrade | null = null;
      if (services.config.deltaApiKey && services.config.deltaApiSecret) {
        account = await services.delta.getAccountRiskSnapshot();
        trade = await this.reconcile(account);
        if (!chatOnly) {
          const state = syncDailyLossCap(services, account);
          if (services.risk.dailyLossBreached(state, account.unrealizedPnl, account.realizedPnl)) throw new Error("UTC daily-loss cap reached");
          if (this.closingAll && settings.revision !== this.repository.settings().revision) {
            this.repository.event("activity", "Review proposal discarded during owned-close reconciliation.");
            return;
          }
          if (trade?.status === "entry_pending" || trade?.status === "exit_pending") return;
        }
      } else if (!chatOnly) throw new Error("Demo credentials are unavailable");
      const positionState = !account ? "unavailable" : trade?.status === "open" ? "owned-open"
        : trade ? "pending" : account.positions.length ? "external" : account.openOrders.length ? "pending" : "flat";
      const allowedActions: AgentDecision["action"][] = chatOnly || !account ? ["wait"]
        : positionState === "owned-open" ? ["wait", "hold", "close"]
        : positionState === "flat" ? ["wait", "open"] : ["wait"];
      const contextFeeRate = !chatOnly ? await services.delta.getAgentFeeRate() : null;
      this.repository.event("activity", [
        `Context ready: ${Math.min(candles.length, 60)} closed ${settings.timeframe} candles; latest closed candle ${new Date(latest.timestamp).toISOString()}.`,
        account ? `Account reconciled: ${account.positions.length} position(s), ${account.openOrders.length} working order(s).` : "Account unavailable: market-only chat analysis.",
        `Agent trade: ${trade?.status ?? "none"}. Entry attempts today (UTC): ${this.repository.entryCount(started)}/5.`,
        contextFeeRate ? `Tax-inclusive taker fee rate per leg: ${contextFeeRate}.` : "No fee quote requested for chat-only analysis."
      ].join("\n"));
      this.repository.event("activity", "Requesting NVIDIA market assessment and concise decision summary.");
      const context = {
        environment: services.config.deltaEnvironment, timeframe: settings.timeframe, snapshotAt: this.now(),
        candles: candles.slice(-60), account, activeTrade: trade, positionState, allowedActions,
        taxInclusiveTakerFeeRate: contextFeeRate,
        entriesToday: this.repository.entryCount(started), conversation: this.repository.conversation(),
        policy: { maxMarginPercent: String(DEMO_MAX_MARGIN_PERCENT),
          maxLeverage: Math.min(DEMO_MAX_LEVERAGE, services.config.maxLeverage, services.botState.get().maxLeverage),
          maxPlannedLossPercentOfEquity: String(DEMO_MAX_PLANNED_LOSS_PERCENT), maxEntriesPerUtcDay: 5,
          dailyLossPercent: String(DEMO_DAILY_LOSS_PERCENT) }
      };
      const promptHash = createHash("sha256").update(JSON.stringify(context)).digest("hex");
      let decision: AgentDecision;
      try {
        decision = await this.model.decide(context, chatOnly);
      } catch {
        services.aiAudit.record({ model: services.config.aiModel, promptHash,
          decision: "rejected", accepted: false, rejectionReason: "Agent provider response was invalid or unavailable" });
        throw new Error("NVIDIA decision was unavailable or invalid; no action was authorized");
      }
      if (!chatOnly && decision.action === "hold" && allowedActions.includes("hold")) {
        trade = await this.reconcile(await services.delta.getAccountRiskSnapshot());
      }
      if (!allowedActions.includes(decision.action) ||
          ((decision.action === "hold" || decision.action === "close") && trade?.status !== "open")) {
        const reason = decision.action === "hold" || decision.action === "close"
          ? `NVIDIA ${decision.action.toUpperCase()} rejected: no verified open app-owned BTCUSD position. Historical conversation is not current position evidence; no action was authorized.`
          : `NVIDIA ${decision.action.toUpperCase()} contradicts the verified account state or chat-only restrictions; no action was authorized.`;
        services.aiAudit.record({ model: services.config.aiModel, promptHash,
          decision: "rejected", accepted: false, rejectionReason: reason });
        throw new Error(reason);
      }
      services.aiAudit.record({ model: services.config.aiModel, promptHash,
        decision: JSON.stringify(decision), accepted: true, rejectionReason: null });
      const responseLines = [
        chatOnly ? "Chat analysis (no trading action)" : `Scheduled ${settings.timeframe} review`,
        `Action: ${decision.action.toUpperCase()}`
      ];
      if (decision.action === "open") {
        responseLines.push(
          `Side: ${decision.side.toUpperCase()}`,
          `Requested margin: ${decision.marginPercent}% of USD equity`,
          `Requested leverage: ${decision.leverage}x`,
          `Proposed stop: ${decision.stopPrice}`,
          `Proposed target: ${decision.takeProfitPrice}`
        );
      }
      responseLines.push(`Summary: ${decision.summary}`);
      if (!chatOnly && (decision.action === "open" || decision.action === "close")) {
        responseLines.push("Proposal only; independent risk checks and exchange confirmation follow.");
      }
      this.repository.event("assistant", responseLines.join("\n"));
      if (this.closingAll && settings.revision !== this.repository.settings().revision) {
        this.repository.event("activity", "Review proposal discarded for the operator's Demo owned-close action; no new order authorized.");
        return;
      }
      if (chatOnly) {
        this.repository.event("activity", "Chat complete. No order was authorized or submitted.");
        return;
      }
      if (this.stopped || settings.revision !== this.repository.settings().revision ||
          !services.botState.get().enabled || services.botState.get().killSwitch ||
          this.now() - started > 60_000 || Math.floor(this.now() / period) * period - period !== expectedCandle) {
        throw new Error("Decision expired or controls changed; no order was authorized");
      }
      if (decision.action === "wait" || decision.action === "hold") {
        this.repository.event("activity", `Decision: ${decision.action.toUpperCase()}. No order submitted.`);
        return;
      }
      this.repository.event("activity", "Risk check: refreshing account PnL and verifying position ownership before evaluating the LLM proposal.");
      account = await services.delta.getAccountRiskSnapshot();
      const state = syncDailyLossCap(services, account);
      if (services.risk.dailyLossBreached(state, account.unrealizedPnl, account.realizedPnl)) throw new Error("UTC daily-loss cap reached before submission");
      trade = await this.reconcile(account);
      if (this.closingAll && settings.revision !== this.repository.settings().revision) {
        this.repository.event("activity", "Review proposal discarded during owned-close reconciliation.");
        return;
      }
      if (settings.revision !== this.repository.settings().revision || !services.botState.get().enabled || services.botState.get().killSwitch) {
        throw new Error("Automation changed during reconciliation; proposal discarded");
      }
      if (decision.action === "close") {
        if (!trade || trade.status !== "open") throw new Error("No confirmed agent-owned position is available to close");
        await this.closeOwnedTrade(trade);
        return;
      }
      const { result, contractValue } = await this.prepareEntry(decision);
      if (!result.approved) {
        this.repository.event("activity", `Trade skipped by risk checks: ${result.reason}`);
        return;
      }
      if (this.closingAll && settings.revision !== this.repository.settings().revision) {
        this.repository.event("activity", "Entry proposal discarded for the operator's Demo owned-close action.");
        return;
      }
      if (this.stopped || settings.revision !== this.repository.settings().revision) throw new Error("Controls changed before submission");
      await this.submitEntry(result.approval, contractValue, decision.summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent review failed";
      if (!chatOnly) this.halt(message);
      else this.repository.event("error", message);
    } finally { this.busy = false; }
  }
}
