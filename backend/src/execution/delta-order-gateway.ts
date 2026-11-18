import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { deltaEndpointsByEnvironment, type DeltaClientConfig, type DeltaProductSpec } from "../exchange/delta-client.js";
import { createDeltaSignature } from "../exchange/signing.js";
import type { Side } from "../domain.js";
import { leverageCeiling } from "../domain.js";
import type { AgentCloseApproval, EmergencyCloseApproval, RiskApproval } from "../domain.js";
import { hasConsumedAgentCloseApproval, hasConsumedEmergencyCloseApproval, hasConsumedRiskApproval } from "../risk-core/risk-core.js";

export type ProductSpecResolver = () => Promise<DeltaProductSpec>;

export interface OrderGateway {
  placeOrder(payload: {
    productId: number;
    side: Side;
    quantity: string;
    leverage: number;
    stopPrice: string;
    takeProfitPrice: string;
    clientOrderId: string;
  }, approval: RiskApproval): Promise<unknown>;
  cancelAllOrders?(productId: number, approval: EmergencyCloseApproval): Promise<unknown>;
  closeAllPositions?(productId: number, approval: EmergencyCloseApproval): Promise<unknown>;
  confirmNoOpenOrders?(productId: number): Promise<boolean>;
  confirmNoOpenPositions?(productId: number): Promise<boolean>;
  closeAgentPosition?(approval: AgentCloseApproval): Promise<unknown>;
}
export type TestnetOrderGateway = OrderGateway;

interface DeltaOrderEnvelope {
  success?: boolean;
  result?: unknown;
  meta?: Record<string, unknown>;
  error?: { code?: string };
}

export class DeltaIndiaOrderGateway implements OrderGateway {
  constructor(
    private readonly config: DeltaClientConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly resolveProduct?: ProductSpecResolver,
    private readonly canEnter: () => boolean = () => true
  ) {}

  async placeOrder(payload: {
    productId: number;
    side: Side;
    quantity: string;
    leverage: number;
    stopPrice: string;
    takeProfitPrice: string;
    clientOrderId: string;
  }, approval: RiskApproval): Promise<unknown> {
    if (!this.config.apiKey || !this.config.apiSecret) throw new Error("Delta credentials are not configured");
    if (
      !hasConsumedRiskApproval(approval) ||
      payload.productId !== this.config.productId ||
      approval.productId !== payload.productId ||
      approval.side !== payload.side ||
      approval.quantity !== payload.quantity ||
      approval.leverage !== payload.leverage ||
      approval.stopPrice !== payload.stopPrice ||
      approval.takeProfitPrice !== payload.takeProfitPrice ||
      payload.clientOrderId !== approval.approvalId.replaceAll("-", "")
    ) {
      throw new Error("Delta gateway requires a consumed matching RiskApproval");
    }
    const quantity = new Decimal(payload.quantity);
    const leverage = new Decimal(payload.leverage);
    let stopPrice = new Decimal(payload.stopPrice);
    let takeProfitPrice = new Decimal(payload.takeProfitPrice);
    let size = quantity;
    if (this.resolveProduct) {
      const spec = await this.resolveProduct();
      if (!spec.live || spec.symbol !== "BTCUSD") throw new Error("Delta order product is not the live BTCUSD contract");
      const exchangeMax = new Decimal(spec.maxLeverage);
      if (!exchangeMax.isFinite() || exchangeMax.lt(1) || leverage.gt(exchangeMax)) {
        throw new Error("Delta order leverage exceeds verified exchange product cap");
      }
      const contractValue = new Decimal(spec.contractValue);
      const tickSize = new Decimal(spec.tickSize);
      // Approvals are sized in base units; Delta orders are sized in whole contracts.
      size = quantity.div(contractValue).floor();
      // Round toward entry so bracket prices land on the tick grid without widening risk.
      stopPrice = roundToTick(stopPrice, tickSize, payload.side === "buy" ? Decimal.ROUND_UP : Decimal.ROUND_DOWN);
      takeProfitPrice = roundToTick(takeProfitPrice, tickSize, payload.side === "buy" ? Decimal.ROUND_DOWN : Decimal.ROUND_UP);
    }
    if (!size.isFinite() || !size.gt(0) || !size.isInteger() || size.gt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Delta order size must be a positive whole contract quantity");
    }
    if (!leverage.isFinite() || !leverage.gt(0) || leverage.gt(leverageCeiling(this.config.environment ?? "testnet")) ||
        (!this.resolveProduct && leverage.gt(2))) {
      throw new Error("Delta order leverage exceeds the hard maximum");
    }
    if (!stopPrice.isFinite() || !stopPrice.gt(0) ||
        !takeProfitPrice.isFinite() || !takeProfitPrice.gt(0) ||
        (payload.side === "buy" && (!stopPrice.lt(approval.entryPrice) || !takeProfitPrice.gt(approval.entryPrice))) ||
        (payload.side === "sell" && (!stopPrice.gt(approval.entryPrice) || !takeProfitPrice.lt(approval.entryPrice)))) {
      throw new Error("Delta exchange-side stop-loss or take-profit bracket is invalid");
    }
    if (!/^[a-f0-9]{32}$/.test(payload.clientOrderId)) throw new Error("Delta client order ID is invalid");

    if (!this.canEnter()) throw new Error("Automation was paused before submission");
    await this.request(`/v2/products/${payload.productId}/orders/leverage`, "POST", { leverage: leverage.toString() });
    if (!this.canEnter()) throw new Error("Automation was paused before submission");
    return this.request("/v2/orders", "POST", {
      product_id: payload.productId,
      size: size.toNumber(),
      side: payload.side,
      order_type: "market_order",
      client_order_id: payload.clientOrderId,
      bracket_stop_loss_price: stopPrice.toString(),
      bracket_take_profit_price: takeProfitPrice.toString(),
      bracket_stop_trigger_method: "mark_price"
    });
  }

  async closeAgentPosition(approval: AgentCloseApproval): Promise<unknown> {
    const canClose = () => approval.intent === "manual-owned-close" || this.canEnter();
    if (!hasConsumedAgentCloseApproval(approval) || this.config.environment !== "testnet" ||
        approval.productId !== this.config.productId || !canClose()) {
      throw new Error("Agent close requires a matching Demo risk approval and enabled automation");
    }
    await this.assertConfiguredProduct(approval.productId);
    const positions = await this.getProductPositions(approval.productId);
    if (positions.length !== 1) throw new Error("Owned position could not be verified before closing");
    const size = new Decimal(String(positions[0]!.size));
    if (!size.abs().eq(approval.contracts) || (size.gt(0) ? "sell" : "buy") !== approval.side ||
        !canClose()) throw new Error("Position changed before close submission");
    return this.request("/v2/orders", "POST", {
      product_id: approval.productId, size: size.abs().toNumber(), side: approval.side,
      order_type: "market_order", reduce_only: "true",
      client_order_id: approval.approvalId.replaceAll("-", "")
    });
  }

  async cancelAllOrders(productId: number, approval: EmergencyCloseApproval): Promise<unknown> {
    this.validateEmergencyApproval(productId, approval);
    await this.assertConfiguredProduct(productId);
    return this.request("/v2/orders/all", "DELETE", {
      product_id: productId,
      cancel_limit_orders: "true",
      cancel_stop_orders: "true",
      cancel_reduce_only_orders: "true"
    });
  }

  async closeAllPositions(productId: number, approval: EmergencyCloseApproval): Promise<unknown> {
    this.validateEmergencyApproval(productId, approval);
    await this.assertConfiguredProduct(productId);
    const positions = await this.getProductPositions(productId);
    for (const [index, position] of positions.entries()) {
      const size = new Decimal(String(position.size));
      if (!size.isInteger() || size.abs().gt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("Delta position size is not a safe whole contract quantity");
      }
      const positionId = String(position.id ?? index);
      const clientOrderId = createHash("sha256")
        .update(`${approval.approvalId}:${productId}:${positionId}`)
        .digest("hex")
        .slice(0, 32);
      await this.request("/v2/orders", "POST", {
        product_id: productId,
        size: size.abs().toNumber(),
        side: size.isPositive() ? "sell" : "buy",
        order_type: "market_order",
        reduce_only: "true",
        client_order_id: clientOrderId
      });
    }
    return { submitted: positions.length };
  }

  async confirmNoOpenOrders(productId: number): Promise<boolean> {
    return (await this.getProductOpenOrders(productId)).length === 0;
  }

  async confirmNoOpenPositions(productId: number): Promise<boolean> {
    return (await this.getProductPositions(productId)).length === 0;
  }

  private validateEmergencyApproval(productId: number, approval: EmergencyCloseApproval): void {
    if (!this.config.apiKey || !this.config.apiSecret) throw new Error("Delta credentials are not configured");
    if (
      !hasConsumedEmergencyCloseApproval(approval) ||
      approval.intent !== "emergency-close" ||
      approval.productId !== productId ||
      this.config.productId !== productId
    ) {
      throw new Error("Delta emergency action requires a consumed matching risk approval");
    }
  }

  private async assertConfiguredProduct(productId: number): Promise<void> {
    if (productId !== this.config.productId) {
      throw new Error("Delta action product does not match the configured product");
    }
    if (this.resolveProduct) {
      const spec = await this.resolveProduct();
      if (!spec.live || spec.symbol !== "BTCUSD") {
        throw new Error("Delta action product is not the live BTCUSD contract");
      }
    }
  }

  private async getProductOpenOrders(productId: number): Promise<Array<Record<string, unknown>>> {
    const orders: Array<Record<string, unknown>> = [];
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const query = new URLSearchParams({
        product_ids: String(productId),
        states: "open,pending",
        page_size: "100"
      });
      if (after) query.set("after", after);
      const envelope = await this.requestEnvelope(`/v2/orders?${query.toString()}`, "GET");
      if (!Array.isArray(envelope.result) || envelope.result.some((item) => !isRecord(item))) {
        throw new Error("Delta India open-order response was invalid");
      }
      orders.push(...envelope.result as Array<Record<string, unknown>>);
      if (!isRecord(envelope.meta) || !Object.hasOwn(envelope.meta, "after")) {
        throw new Error("Delta India open-order pagination metadata was missing");
      }
      const next = envelope.meta.after;
      if (next === null || next === "") return orders;
      if (typeof next !== "string" || cursors.has(next)) {
        throw new Error("Delta India open-order pagination cursor was invalid");
      }
      cursors.add(next);
      after = next;
    }
    throw new Error("Delta India open-order history exceeded the page limit");
  }

  private async getProductPositions(productId: number): Promise<Array<Record<string, unknown>>> {
    const query = new URLSearchParams({ product_ids: String(productId) });
    const result = await this.request(`/v2/positions/margined?${query.toString()}`, "GET");
    if (!Array.isArray(result) || result.some((item) => !isRecord(item))) {
      throw new Error("Delta India position response was invalid");
    }
    return result.flatMap((position: Record<string, unknown>) => {
      if (!Number.isSafeInteger(Number(position.product_id))) {
        throw new Error("Delta India position did not contain a valid product ID");
      }
      if (Number(position.product_id) !== productId) {
        throw new Error("Delta India returned a position outside the requested product");
      }
      let size: Decimal;
      try {
        size = new Decimal(String(position.size));
      } catch {
        throw new Error("Delta India position size was invalid");
      }
      if (!size.isFinite()) throw new Error("Delta India position size was invalid");
      return size.isZero() ? [] : [position];
    });
  }

  private async request(path: string, method: "GET" | "POST" | "DELETE", value?: Record<string, unknown>): Promise<unknown> {
    const envelope = await this.requestEnvelope(path, method, value);
    return envelope.result ?? envelope;
  }

  private async requestEnvelope(
    path: string,
    method: "GET" | "POST" | "DELETE",
    value?: Record<string, unknown>
  ): Promise<DeltaOrderEnvelope> {
    const body = value ? JSON.stringify(value) : "";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createDeltaSignature(this.config.apiSecret, method, timestamp, path, body);
    let response: Response;
    try {
      response = await this.fetcher(`${deltaEndpointsByEnvironment[this.config.environment ?? "testnet"].rest}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          "api-key": this.config.apiKey,
          timestamp,
          signature
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new Error("Delta India order request failed");
    }
    if (!response.ok) throw new Error(`Delta India rejected the request (HTTP ${response.status})`);
    let envelope: DeltaOrderEnvelope;
    try {
      envelope = await response.json() as typeof envelope;
    } catch {
      throw new Error("Delta India returned an invalid response");
    }
    if (envelope.success === false) {
      throw new Error(`Delta India rejected the request${envelope.error?.code ? ` (${envelope.error.code})` : ""}`);
    }
    return envelope;
  }
}

export { DeltaIndiaOrderGateway as DeltaIndiaTestnetOrderGateway };

function roundToTick(value: Decimal, tick: Decimal, rounding: Decimal.Rounding): Decimal {
  return value.div(tick).toDecimalPlaces(0, rounding).mul(tick);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
