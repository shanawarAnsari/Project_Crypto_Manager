import Decimal from "decimal.js";
import { TIMEFRAME_SECONDS, type Candle, type ChartTimeframe } from "../domain.js";
import { createDeltaSignature } from "./signing.js";

const INDIA_DEMO_REST_URL = "https://cdn-ind.testnet.deltaex.org";
const INDIA_PRODUCTION_REST_URL = "https://api.india.delta.exchange";

export type DeltaEnvironment = "production" | "testnet";

export const DELTA_INDIA_USD_INR_RATE = "85";

// Fixed allow-list: the Delta Global host is intentionally absent.
export const deltaEndpointsByEnvironment = Object.freeze({
  testnet: { rest: INDIA_DEMO_REST_URL, socket: "wss://socket-ind.testnet.deltaex.org" },
  production: { rest: INDIA_PRODUCTION_REST_URL, socket: "wss://socket.india.delta.exchange" }
} as const);

interface DeltaEnvelope<T> {
  success?: boolean;
  result?: T;
  meta?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

export class DeltaApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "DeltaApiError";
  }
}

export interface DeltaClientConfig {
  apiKey: string;
  apiSecret: string;
  productId: number;
  environment?: DeltaEnvironment;
}

export interface DeltaProductSpec {
  maxLeverage: string;
  symbol: string;
  contractValue: string;
  tickSize: string;
  live: boolean;
}

export interface DeltaPositionSnapshot {
  id: string;
  productId: number;
  symbol: string;
  side: "buy" | "sell";
  quantity: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  leverage: string;
  stopPrice: string | null;
  takeProfitPrice: string | null;
}

export interface DeltaOpenOrderSnapshot {
  id: string;
  productId: number;
  symbol: string;
  side: "buy" | "sell";
  orderType: string;
  quantity: string;
  limitPrice: string | null;
  stopOrderType: string | null;
  triggerPrice: string | null;
  status: string;
  createdAt: string;
}

export interface DeltaAccountSnapshot {
  equity: string;
  availableMargin: string;
  marginUsed: string;
  unrealizedPnl: string;
  positions: DeltaPositionSnapshot[];
  openOrders: DeltaOpenOrderSnapshot[];
}

export interface DeltaAccountRiskSnapshot extends DeltaAccountSnapshot {
  realizedPnl: string;
}

export interface DeltaAgentOrder {
  productId: number;
  side: "buy" | "sell";
  contracts: string;
  unfilledContracts: string;
  averageFillPrice: string;
  paidCommission: string;
  state: string;
  stopPrice: string | null;
  takeProfitPrice: string | null;
}

export interface DeltaPortfolioValuation {
  totalUsd: string;
  totalInr: string;
  holdings: Array<{
    asset: string;
    quantity: string;
    valueUsd: string;
    valueInr: string;
  }>;
}

interface DeltaWalletTransaction {
  amount: Decimal;
  transactionType: string;
}

const WALLET_PAGE_SIZE = 50;
const MAX_WALLET_TRANSACTION_PAGES = 100;
const OPEN_ORDER_PAGE_SIZE = 100;
const MAX_OPEN_ORDER_PAGES = 100;
const PNL_TRANSACTION_TYPES = new Set([
  "cashflow",
  "commission",
  "commission_rebate",
  "funding",
  "settlement",
  "liquidation_fee",
  "spot_trade",
  "trading_credits_paid",
  "trading_fee_credits_paid_liquidation_fee",
  "trading_credits_reverted",
  "fill_appropriation"
]);
const NON_PNL_TRANSACTION_TYPES = new Set([
  "deposit",
  "withdrawal",
  "conversion",
  "withdrawal_cancellation",
  "referral_bonus",
  "sub_account_transfer",
  "promo_credit",
  "trading_credits",
  "trading_credits_forfeited",
  "interest_credit",
  "external_deposit",
  "credit_line",
  "trading_competition",
  "fund_deposit",
  "fund_withdrawal",
  "fund_wallet_deposit",
  "fund_wallet_withdrawal",
  "fund_reward",
  "trade_farming_reward",
  "raf_bonus",
  "incident_compensation"
]);

export class DeltaIndiaClient {
  private readonly baseUrl: string;
  constructor(private readonly config: DeltaClientConfig, private readonly fetcher: typeof fetch = fetch) {
    this.baseUrl = deltaEndpointsByEnvironment[config.environment ?? "testnet"].rest;
  }

  async getProductSpec(): Promise<DeltaProductSpec> {
    const raw = await this.getProductDetails();
    if (typeof raw !== "object" || raw === null) throw new DeltaApiError("Exchange product response was invalid", 502);
    const item = raw as Record<string, unknown>;
    if (item.symbol !== "BTCUSD" || Number(item.id) !== this.config.productId) {
      throw new DeltaApiError("Delta product did not match the configured BTCUSD contract", 502);
    }
    const contractValue = String(item.contract_value ?? "");
    const tickSize = String(item.tick_size ?? "");
    const initialMargin = decimalField(item.initial_margin, "product initial margin");
    if (!initialMargin.isFinite() || initialMargin.lte(0) || initialMargin.gt(100)) {
      throw new DeltaApiError("Exchange product initial margin is invalid", 502);
    }
    for (const value of [contractValue, tickSize]) {
      if (!/^\d+(\.\d+)?$/.test(value) || new Decimal(value).lte(0)) {
        throw new DeltaApiError("Exchange product response was missing contract or tick size", 502);
      }
    }
    return {
      maxLeverage: new Decimal(100).div(initialMargin).toString(),
      symbol: String(item.symbol ?? ""),
      contractValue,
      tickSize,
      live: item.state === "live" && item.trading_status === "operational"
    };
  }

    async getAgentFeeRate(): Promise<string> {
      const raw = await this.getProductDetails();
      if (!isRecord(raw) || raw.symbol !== "BTCUSD" || Number(raw.id) !== this.config.productId ||
          raw.state !== "live" || raw.trading_status !== "operational") {
        throw new DeltaApiError("BTCUSD fee product could not be verified", 502);
      }
      const rate = decimalField(raw.taker_commission_rate, "taker commission rate");
      if (rate.lte(0) || rate.gt("0.01")) throw new DeltaApiError("Taker fee rate is outside its supported range", 502);
      // Delta India publishes 18% GST on trading fees; use taker fees for both market-order legs.
      return rate.mul("1.18").toString();
    }

    async getAgentOrder(clientOrderId: string): Promise<DeltaAgentOrder> {
      if (!/^[a-f0-9]{32}$/.test(clientOrderId)) throw new DeltaApiError("Invalid agent order identity", 400);
      const raw = await this.request<unknown>(`/v2/orders/client_order_id/${clientOrderId}`, { auth: true });
      if (!isRecord(raw) || Number(raw.product_id) !== this.config.productId ||
          raw.client_order_id !== clientOrderId || !parseSide(raw.side) || typeof raw.state !== "string") {
        throw new DeltaApiError("Agent order identity could not be reconciled", 502);
      }
      const contracts = decimalField(raw.size, "agent order size");
      const unfilled = decimalField(raw.unfilled_size, "agent unfilled size");
      const price = decimalField(raw.average_fill_price ?? "0", "agent fill price");
      const commission = decimalField(raw.paid_commission, "agent paid commission");
      if (!contracts.isInteger() || contracts.lte(0) || !unfilled.isInteger() ||
          unfilled.lt(0) || unfilled.gt(contracts) || price.lt(0) || commission.lt(0)) {
        throw new DeltaApiError("Agent order fill data was invalid", 502);
      }
      return { productId: this.config.productId, side: parseSide(raw.side)!,
        contracts: contracts.toString(), unfilledContracts: unfilled.toString(),
        averageFillPrice: price.toString(), paidCommission: commission.toString(), state: raw.state,
        stopPrice: nullableDecimal(raw.bracket_stop_loss_price, "agent bracket stop"),
        takeProfitPrice: nullableDecimal(raw.bracket_take_profit_price, "agent bracket target") };
    }
  async getCandles(timeframe: ChartTimeframe, symbol: string, limit = 500): Promise<Candle[]> {
    const now = Math.floor(Date.now() / 1000);
    const start = now - TIMEFRAME_SECONDS[timeframe] * Math.min(Math.max(limit, 1), 1000);
    const query = new URLSearchParams({
      resolution: timeframe,
      symbol,
      start: String(start),
      end: String(now)
    });
    const results = await this.request<unknown>(`/v2/history/candles?${query.toString()}`);
    if (!Array.isArray(results)) throw new DeltaApiError("Delta India candle response was invalid", 502);
    return results.map((rawItem: unknown) => {
      if (!isRecord(rawItem)) throw new DeltaApiError("Delta India candle record was invalid", 502);
      const item = rawItem as Record<string, unknown>;
      const candle: Candle = {
        timestamp: Number(item.time ?? item.timestamp) * 1000,
        open: String(item.open),
        high: String(item.high),
        low: String(item.low),
        close: String(item.close),
        volume: String(item.volume ?? "0")
      };
      if (!isValidCandle(candle)) throw new DeltaApiError("Delta India candle record was invalid", 502);
      return candle;
    }).sort((a, b) => a.timestamp - b.timestamp);
  }

  // Delta India converts INR<->USD at a fixed 85; display-only, never used for risk or sizing.
  getUsdInrRate(): string {
    return DELTA_INDIA_USD_INR_RATE;
  }

  async getPortfolioValuation(): Promise<DeltaPortfolioValuation> {
    const balances = arrayResult(await this.getBalances(), "wallet balances");
    const seen = new Set<string>();
    const wallets = balances.map((wallet) => {
      const asset = wallet.asset_symbol;
      if (typeof asset !== "string" || !/^[A-Z][A-Z0-9_]{0,19}$/.test(asset) || seen.has(asset)) {
        throw new DeltaApiError("Delta portfolio contained an invalid or duplicate asset", 502);
      }
      seen.add(asset);
      return { asset, quantity: decimalField(wallet.balance, "portfolio wallet balance"), valueInr: wallet.balance_inr };
    }).filter((wallet) => !wallet.quantity.isZero());
    if (!seen.has("USD")) throw new DeltaApiError("Delta wallet response did not contain a USD balance", 502);
    const holdings = wallets.map(({ asset, quantity, valueInr }) => {
      const inr = decimalField(valueInr, "portfolio INR wallet valuation");
      if (inr.isZero() || inr.isNegative() !== quantity.isNegative()) {
        throw new DeltaApiError("Delta portfolio INR wallet valuation did not match its balance", 502);
      }
      return {
        asset, quantity: quantity.toString(), valueInr: inr.toString(),
        valueUsd: inr.div(this.getUsdInrRate()).toString()
      };
    });
    const total = holdings.reduce((sum, holding) => sum.plus(holding.valueInr), new Decimal(0));
    return {
      totalUsd: total.div(this.getUsdInrRate()).toString(),
      totalInr: total.toDecimalPlaces(2).toString(),
      holdings
    };
  }

  async getTicker(symbol: string): Promise<{ price: string; fundingRate: string | null }> {
    const result = await this.request<Record<string, unknown>>(`/v2/tickers/${encodeURIComponent(symbol)}`);
    const price = result.mark_price ?? result.close ?? result.last_price;
    if (price === undefined || price === null) throw new DeltaApiError("Exchange ticker response did not contain a price", 502);
    let normalized: Decimal;
    try {
      normalized = new Decimal(String(price));
    } catch {
      throw new DeltaApiError("Exchange ticker response contained an invalid price", 502);
    }
    if (!normalized.isFinite() || normalized.lte(0)) throw new DeltaApiError("Exchange ticker response contained an invalid price", 502);
    const rawFundingRate = result.funding_rate;
    if (rawFundingRate === undefined || rawFundingRate === null) return { price: normalized.toString(), fundingRate: null };
    let fundingRate: Decimal;
    try {
      fundingRate = new Decimal(String(rawFundingRate));
    } catch {
      throw new DeltaApiError("Exchange ticker response contained an invalid funding rate", 502);
    }
    if (!fundingRate.isFinite()) throw new DeltaApiError("Exchange ticker response contained an invalid funding rate", 502);
    return { price: normalized.toString(), fundingRate: fundingRate.toString() };
  }

  async getBalances(): Promise<unknown> {
    return this.request("/v2/wallet/balances", { auth: true });
  }

  async getPositions(): Promise<unknown> {
    return this.request("/v2/positions/margined", { auth: true });
  }

  async getOpenOrders(): Promise<unknown> {
    const orders: Array<Record<string, unknown>> = [];
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_OPEN_ORDER_PAGES; pageNumber += 1) {
      const query = new URLSearchParams({
        product_ids: String(this.config.productId),
        states: "open,pending",
        page_size: String(OPEN_ORDER_PAGE_SIZE)
      });
      if (after) query.set("after", after);
      const envelope = await this.requestEnvelope<unknown>(`/v2/orders?${query.toString()}`, { auth: true });
      orders.push(...arrayResult(envelope.result, "open orders"));
      if (!isRecord(envelope.meta) || !Object.hasOwn(envelope.meta, "after")) {
        throw new DeltaApiError("Delta open-order pagination metadata was missing", 502);
      }
      const next = envelope.meta.after;
      if (next === null || next === "") return orders;
      if (typeof next !== "string" || cursors.has(next)) {
        throw new DeltaApiError("Delta open-order pagination cursor was invalid", 502);
      }
      cursors.add(next);
      after = next;
    }
    throw new DeltaApiError("Delta open-order history exceeded the reconciliation page limit", 502);
  }

  async getProductDetails(): Promise<unknown> {
    return this.request("/v2/products/BTCUSD");
  }

  async getAccountSnapshot(): Promise<DeltaAccountSnapshot> {
    const [balances, positions, orders] = await Promise.all([
      this.getBalances(),
      this.getPositions(),
      this.getOpenOrders()
    ]);
    return normalizeAccountSnapshot(balances, positions, orders, this.config.productId);
  }

  async getAccountRiskSnapshot(now = Date.now()): Promise<DeltaAccountRiskSnapshot> {
    const [balances, positions, orders] = await Promise.all([
      this.getBalances(),
      this.getPositions(),
      this.getOpenOrders()
    ]);
    const realizedPnl = await this.getDailyRealizedPnlFromBalances(balances, now);
    return {
      ...normalizeAccountSnapshot(balances, positions, orders, this.config.productId),
      realizedPnl
    };
  }

  async getDailyRealizedPnl(now = Date.now()): Promise<string> {
    const balances = await this.getBalances();
    return this.getDailyRealizedPnlFromBalances(balances, now);
  }

  private async getDailyRealizedPnlFromBalances(balancesValue: unknown, now: number): Promise<string> {
    if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) {
      throw new DeltaApiError("Daily PnL reconciliation time was invalid", 400);
    }
    const balances = arrayResult(balancesValue, "wallet balances");
    const usd = balances.find((item) => item.asset_symbol === "USD");
    const assetId = usd ? Number(usd.asset_id) : NaN;
    if (!Number.isSafeInteger(assetId) || assetId <= 0) {
      throw new DeltaApiError("Delta wallet response did not contain a valid USD asset ID", 502);
    }
    const utcDate = new Date(now);
    const startTimeUs = Date.UTC(utcDate.getUTCFullYear(), utcDate.getUTCMonth(), utcDate.getUTCDate()) * 1000;
    const endTimeUs = now * 1000;
    const transactions = await this.getWalletTransactions(assetId, startTimeUs, endTimeUs);
    return transactions.reduce((total, transaction) => {
      if (PNL_TRANSACTION_TYPES.has(transaction.transactionType)) return total.plus(transaction.amount);
      if (NON_PNL_TRANSACTION_TYPES.has(transaction.transactionType)) return total;
      throw new DeltaApiError("Delta wallet returned an unsupported wallet transaction type", 502);
    }, new Decimal(0)).toString();
  }

  private async getWalletTransactions(
    assetId: number,
    startTimeUs: number,
    endTimeUs: number
  ): Promise<DeltaWalletTransaction[]> {
    const transactions: DeltaWalletTransaction[] = [];
    const cursors = new Set<string>();
    let after: string | null = null;
    for (let pageNumber = 0; pageNumber < MAX_WALLET_TRANSACTION_PAGES; pageNumber += 1) {
      const query = new URLSearchParams({
        asset_ids: String(assetId),
        start_time: String(startTimeUs),
        end_time: String(endTimeUs),
        page_size: String(WALLET_PAGE_SIZE)
      });
      if (after) query.set("after", after);
      const envelope = await this.requestEnvelope<unknown>(`/v2/wallet/transactions?${query.toString()}`, { auth: true });
      const rows = arrayResult(envelope.result, "wallet transactions");
      if (!isRecord(envelope.meta) || !Object.hasOwn(envelope.meta, "after")) {
        throw new DeltaApiError("Delta wallet transaction pagination metadata was missing", 502);
      }
      for (const row of rows) {
        const transactionType = row.transaction_type;
        const rowAssetId = Number(row.asset_id);
        const timestamp = row.created_at;
        if (typeof transactionType !== "string" || !transactionType ||
            rowAssetId !== assetId ||
            (typeof timestamp !== "string" && typeof timestamp !== "number")) {
          throw new DeltaApiError("Delta wallet transaction record was invalid", 502);
        }
        transactions.push({
          amount: decimalField(row.amount, "wallet transaction amount"),
          transactionType
        });
      }
      const next = envelope.meta.after;
      if (next === null || next === "") return transactions;
      if (typeof next !== "string" || cursors.has(next)) {
        throw new DeltaApiError("Delta wallet transaction pagination cursor was invalid", 502);
      }
      cursors.add(next);
      after = next;
    }
    throw new DeltaApiError("Delta wallet transaction history exceeded the reconciliation page limit", 502);
  }

  private async request<T = unknown>(
    path: string,
    options: { auth?: boolean; method?: "GET" | "POST"; body?: Record<string, unknown> } = {}
  ): Promise<T> {
    const envelope = await this.requestEnvelope<T>(path, options);
    return (envelope.result ?? envelope) as T;
  }

  private async requestEnvelope<T = unknown>(
    path: string,
    options: { auth?: boolean; method?: "GET" | "POST"; body?: Record<string, unknown> } = {}
  ): Promise<DeltaEnvelope<T>> {
    const method = options.method ?? "GET";
    const body = options.body ? JSON.stringify(options.body) : "";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = { accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
    if (options.auth) {
      if (!this.config.apiKey || !this.config.apiSecret) {
        throw new DeltaApiError("Delta API credentials are not configured", 503);
      }
      const signature = createDeltaSignature(this.config.apiSecret, method, timestamp, path, body);
      headers["api-key"] = this.config.apiKey;
      headers["timestamp"] = timestamp;
      headers["signature"] = signature;
    }
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new DeltaApiError("Delta India API request failed", 502);
    }
    if (!response.ok) throw new DeltaApiError(`Delta India API returned HTTP ${response.status}`, response.status);
    let envelope: DeltaEnvelope<T>;
    try {
      envelope = await response.json() as DeltaEnvelope<T>;
    } catch {
      throw new DeltaApiError("Delta India API returned invalid JSON", 502);
    }
    if (envelope.success === false) {
      throw new DeltaApiError(`Delta India API rejected the request${envelope.error?.code ? ` (${envelope.error.code})` : ""}`, 502);
    }
    return envelope;
  }
}

export const deltaIndiaEndpoints = Object.freeze({ demo: INDIA_DEMO_REST_URL });

function normalizeAccountSnapshot(
  rawBalances: unknown,
  rawPositions: unknown,
  rawOrders: unknown,
  productId: number
): DeltaAccountSnapshot {
  const balances = arrayResult(rawBalances, "wallet balances");
  const usd = balances.find((item) => item.asset_symbol === "USD");
  if (!usd) throw new DeltaApiError("Delta wallet response did not contain a USD balance", 502);
  const equity = decimalField(usd.balance, "wallet balance");
  const availableMargin = decimalField(usd.available_balance, "available balance");
  const orderMargin = decimalField(usd.order_margin ?? "0", "order margin");
  const positionMargin = decimalField(usd.position_margin ?? "0", "position margin");

  const positions = arrayResult(rawPositions, "positions").flatMap((item): DeltaPositionSnapshot[] => {
    const productId = Number(item.product_id);
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      throw new DeltaApiError("Delta position response contained an invalid product ID", 502);
    }
    const rawSize = decimalField(item.size, "position size");
    if (rawSize.isZero()) return [];
    const side = parseSide(item.side) ?? (rawSize.isNegative() ? "sell" : "buy");
    const quantity = rawSize.abs();
    const entryPrice = decimalField(item.entry_price, "position entry price");
    const markPrice = decimalField(item.mark_price, "position mark price");
    const unrealizedPnl = decimalField(item.unrealized_pnl, "position unrealized PnL");
    const leverage = decimalField(item.leverage ?? "1", "position leverage");
    if (entryPrice.lte(0) || markPrice.lte(0) || leverage.lte(0)) {
      throw new DeltaApiError("Delta position response contained invalid price or leverage values", 502);
    }
    return [{
      id: String(item.id ?? `${productId}:${side}`),
      productId,
      symbol: typeof item.product_symbol === "string" ? item.product_symbol : "BTCUSD",
      side,
      quantity: quantity.toString(),
      entryPrice: entryPrice.toString(),
      markPrice: markPrice.toString(),
      unrealizedPnl: unrealizedPnl.toString(),
      leverage: leverage.toString(),
      stopPrice: nullableDecimal(item.bracket_stop_loss_price, "position stop price"),
      takeProfitPrice: nullableDecimal(item.bracket_take_profit_price, "position take-profit price")
    }];
  });

  const openOrders = arrayResult(rawOrders, "open orders").flatMap((item): DeltaOpenOrderSnapshot[] => {
    if (Number(item.product_id) !== productId) return [];
    const side = parseSide(item.side);
    if (!side) throw new DeltaApiError("Delta open-order response contained an invalid side", 502);
    const size = decimalField(item.size ?? item.remaining_size, "open-order size").abs();
    if (size.lte(0)) return [];
    const id = item.id;
    if (typeof id !== "string" && typeof id !== "number") {
      throw new DeltaApiError("Delta open-order response did not contain an order ID", 502);
    }
    const orderType = typeof item.order_type === "string" ? item.order_type : "unknown";
    const triggerPrice = nullableDecimal(item.stop_price, "open-order trigger price");
    if (triggerPrice !== null && new Decimal(triggerPrice).lte(0)) {
      throw new DeltaApiError("Delta open-order trigger price must be positive", 502);
    }
    return [{
      id: String(id),
      productId,
      symbol: typeof item.product_symbol === "string" ? item.product_symbol : "BTCUSD",
      side,
      orderType,
      quantity: size.toString(),
      limitPrice: nullableDecimal(item.limit_price, "open-order limit price"),
      stopOrderType: typeof item.stop_order_type === "string" && item.stop_order_type.trim() ? item.stop_order_type : null,
      triggerPrice,
      status: typeof item.state === "string" ? item.state : "open",
      createdAt: typeof item.created_at === "string" ? item.created_at : ""
    }];
  });

  const unrealizedPnl = positions.reduce((total, position) => total.plus(position.unrealizedPnl), new Decimal(0));
  return {
    equity: equity.toString(),
    availableMargin: availableMargin.toString(),
    marginUsed: orderMargin.plus(positionMargin).toString(),
    unrealizedPnl: unrealizedPnl.toString(),
    positions,
    openOrders
  };
}

function arrayResult(value: unknown, label: string): Array<Record<string, unknown>> {
  const candidate = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.positions) ? value.positions
      : isRecord(value) && Array.isArray(value.orders) ? value.orders
        : isRecord(value) && Array.isArray(value.balances) ? value.balances
          : null;
  if (!candidate || candidate.some((item) => !isRecord(item))) {
    throw new DeltaApiError(`Delta ${label} response was invalid`, 502);
  }
  return candidate as Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decimalField(value: unknown, label: string): Decimal {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new DeltaApiError(`Delta ${label} was missing or invalid`, 502);
  }
  let decimal: Decimal;
  try {
    decimal = new Decimal(String(value));
  } catch {
    throw new DeltaApiError(`Delta ${label} was missing or invalid`, 502);
  }
  if (!decimal.isFinite()) throw new DeltaApiError(`Delta ${label} was missing or invalid`, 502);
  return decimal;
}

function nullableDecimal(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return decimalField(value, label).toString();
}

function parseSide(value: unknown): "buy" | "sell" | null {
  return value === "buy" || value === "sell" ? value : null;
}

function isValidCandle(candle: Candle): boolean {
  if (!Number.isSafeInteger(candle.timestamp) || candle.timestamp <= 0) return false;
  try {
    const open = new Decimal(candle.open);
    const high = new Decimal(candle.high);
    const low = new Decimal(candle.low);
    const close = new Decimal(candle.close);
    const volume = new Decimal(candle.volume);
    return [open, high, low, close, volume].every((value) => value.isFinite()) &&
      open.gt(0) && high.gte(open) && high.gte(close) && low.lte(open) &&
      low.lte(close) && low.gt(0) && volume.gte(0);
  } catch {
    return false;
  }
}
