/**
 * Delta Exchange India bridge for the desk: market data, account sync, bracket orders and position management.
 * Hosts are pinned to Delta India (testnet = Demo account, production = real money).
 */
import { createHash } from "node:crypto";
import { deltaEndpointsByEnvironment, type DeltaEnvironment } from "../exchange/delta-client.js";
import { createDeltaSignature } from "../exchange/signing.js";
import { digitsForTick, FIVE_MIN, roundTo, specFor } from "./market.js";
import type { Bar, Direction } from "./types.js";

export const CONFIRM_PHRASE = "I UNDERSTAND THE RISK";

export interface DeltaIssue {
  code: string;
  message: string;
  fix: string;
}

export interface DeltaHealth {
  available: boolean;
  connected: boolean;
  authenticated: boolean;
  environment: DeltaEnvironment;
  issues: DeltaIssue[];
  checked_at: number;
  ping_ms: number | null;
  live_unlocked: boolean;
  allow_live_env: boolean;
  account: { balance: number; available: number; equity: number; asset: string } | null;
  products: Record<string, { id: number; live: boolean; contract_value: number; tick_size: number; max_leverage: number }>;
}

export interface DeltaPosition {
  symbol: string;
  productId: number;
  direction: Direction;
  contracts: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
}

export interface DeltaFill {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  commission: number;
  notional: number;
  order_id: string | null;
  role: string;
  time: number;
}

export interface OrderResult {
  ok: boolean;
  duplicate?: boolean;
  message: string;
  symbol: string;
  orderId?: number | string;
  clientOrderId?: string;
  price?: number;
  contracts?: number;
}

export interface ExecLogRow {
  ts: number;
  kind: string;
  symbol: string;
  status: string;
  order_id: string | null;
  price: number | null;
  contracts: number | null;
  message: string;
}

export interface DeltaBridgeConfig {
  apiKey: string;
  apiSecret: string;
  environment: DeltaEnvironment;
  liveTradingConfirmed: boolean;
}

export class DeltaRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly context?: unknown) {
    super(message);
    this.name = "DeltaRequestError";
  }
}

export class DeltaBridge {
  liveUnlocked = false;
  lastHealth: DeltaHealth;
  private readonly baseUrl: string;
  private readonly products = new Map<string, { id: number; live: boolean; maxLeverage: number; fetchedAt: number }>();

  constructor(
    private readonly cfg: DeltaBridgeConfig,
    private readonly onLog: (row: ExecLogRow) => void = () => undefined,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.baseUrl = deltaEndpointsByEnvironment[cfg.environment].rest;
    this.lastHealth = {
      available: true, connected: false, authenticated: false, environment: cfg.environment, issues: [], checked_at: 0, ping_ms: null,
      live_unlocked: false, allow_live_env: this.allowLiveEnv, account: null, products: {}
    };
  }

  get environment(): DeltaEnvironment {
    return this.cfg.environment;
  }

  get hasCredentials(): boolean {
    return Boolean(this.cfg.apiKey && this.cfg.apiSecret);
  }

  get allowLiveEnv(): boolean {
    return this.cfg.environment === "production" && this.cfg.liveTradingConfirmed;
  }

  accountLabel(): "DEMO" | "LIVE" {
    return this.cfg.environment === "testnet" ? "DEMO" : "LIVE";
  }

  /** True when orders may be sent: credentials present, API healthy and (for production) live explicitly unlocked. */
  isReady(): boolean {
    if (!this.hasCredentials || !this.lastHealth.authenticated) return false;
    return this.cfg.environment === "testnet" || (this.allowLiveEnv && this.liveUnlocked);
  }

  // ------------------------------------------------------------------ HTTP
  private async request<T = unknown>(path: string, opts: { method?: "GET" | "POST" | "PUT" | "DELETE"; auth?: boolean; body?: Record<string, unknown> } = {}): Promise<T> {
    const method = opts.method ?? "GET";
    const body = opts.body ? JSON.stringify(opts.body) : "";
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "crypto-manager-desk" };
    if (body) headers["content-type"] = "application/json";
    if (opts.auth) {
      if (!this.hasCredentials) throw new DeltaRequestError("Delta API credentials are not configured", 401);
      const timestamp = String(Math.floor(Date.now() / 1000));
      headers["api-key"] = this.cfg.apiKey;
      headers.timestamp = timestamp;
      headers.signature = createDeltaSignature(this.cfg.apiSecret, method, timestamp, path, body);
    }
    let res: Response;
    try {
      res = await this.fetcher(`${this.baseUrl}${path}`, { method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new DeltaRequestError("Delta India API is unreachable", 0);
    }
    type Envelope = { success?: boolean; result?: unknown; error?: { code?: string; context?: unknown } };
    let json: Envelope | null;
    try {
      json = await res.json() as Envelope;
    } catch {
      json = null;
    }
    if (!res.ok || json?.success === false) {
      const code = json?.error?.code;
      throw new DeltaRequestError(`Delta India rejected the request (HTTP ${res.status}${code ? `, ${code}` : ""})`, res.status, code, json?.error?.context);
    }
    if (!json) throw new DeltaRequestError("Delta India returned invalid JSON", res.status);
    return (json.result ?? json) as T;
  }

  // ------------------------------------------------------------------ market data
  /** Load product metadata and refresh the shared instrument spec (contract value, tick size, product id). */
  async loadProduct(symbol: string, force = false): Promise<{ id: number; live: boolean; maxLeverage: number }> {
    const cached = this.products.get(symbol);
    if (cached && !force && Date.now() - cached.fetchedAt < 10 * 60_000) return cached;
    const raw = await this.request<Record<string, unknown>>(`/v2/products/${encodeURIComponent(symbol)}`);
    const id = Number(raw.id);
    const cv = Number(raw.contract_value);
    const tick = Number(raw.tick_size);
    const im = Number(raw.initial_margin);
    if (!Number.isSafeInteger(id) || !(cv > 0) || !(tick > 0)) throw new DeltaRequestError(`Delta product ${symbol} metadata was invalid`, 502);
    const spec = specFor(symbol);
    spec.productId = id;
    spec.contractValue = cv;
    spec.tickSize = tick;
    spec.digits = digitsForTick(tick);
    const info = { id, live: raw.state === "live" && raw.trading_status === "operational", maxLeverage: im > 0 ? Math.floor(100 / im) : 1, fetchedAt: Date.now() };
    this.products.set(symbol, info);
    return info;
  }

  /** Closed 5M candles, oldest first. Pages backwards in 2000-bar chunks for long histories. */
  async candles5m(symbol: string, count: number, nowSec = Math.floor(Date.now() / 1000)): Promise<Bar[]> {
    const lastClosedOpen = Math.floor(nowSec / FIVE_MIN) * FIVE_MIN - FIVE_MIN;
    const byTime = new Map<number, Bar>();
    let end = lastClosedOpen + FIVE_MIN - 1;
    let remaining = count;
    while (remaining > 0) {
      const chunk = Math.min(2000, remaining);
      const start = end - chunk * FIVE_MIN + 1;
      const q = new URLSearchParams({ resolution: "5m", symbol, start: String(start), end: String(end) });
      const rows = await this.request<unknown>(`/v2/history/candles?${q.toString()}`);
      if (!Array.isArray(rows)) throw new DeltaRequestError("Delta candle response was invalid", 502);
      for (const r of rows as Array<Record<string, unknown>>) {
        const bar: Bar = { time: Number(r.time), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume ?? 0) };
        if ([bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) && bar.time <= lastClosedOpen && bar.high >= bar.low) byTime.set(bar.time, bar);
      }
      remaining -= chunk;
      end = start - 1;
      if (rows.length === 0) break;
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  async ticker(symbol: string): Promise<{ mark: number; bid: number; ask: number; spreadPct: number }> {
    const r = await this.request<Record<string, unknown>>(`/v2/tickers/${encodeURIComponent(symbol)}`);
    const quotes = (r.quotes ?? {}) as Record<string, unknown>;
    const mark = Number(r.mark_price ?? r.close);
    const bid = Number(quotes.best_bid);
    const ask = Number(quotes.best_ask);
    if (!(mark > 0)) throw new DeltaRequestError(`Delta ticker for ${symbol} had no price`, 502);
    const spreadPct = bid > 0 && ask > 0 && ask >= bid ? (ask - bid) / ((ask + bid) / 2) * 100 : 0;
    return { mark, bid: bid || mark, ask: ask || mark, spreadPct };
  }

  // ------------------------------------------------------------------ account
  async wallet(): Promise<{ balance: number; available: number; asset: string }> {
    const rows = await this.request<Array<Record<string, unknown>>>("/v2/wallet/balances", { auth: true });
    if (!Array.isArray(rows)) throw new DeltaRequestError("Delta wallet response was invalid", 502);
    const usd = rows.find((w) => w.asset_symbol === "USD") ?? rows.find((w) => w.asset_symbol === "USDT");
    if (!usd) throw new DeltaRequestError("Delta wallet did not contain a USD or USDT balance", 502);
    const balance = Number(usd.balance);
    const available = Number(usd.available_balance);
    if (usd.balance == null || usd.available_balance == null || !Number.isFinite(balance) || !Number.isFinite(available)) {
      throw new DeltaRequestError("Delta wallet contained invalid balances", 502);
    }
    return { balance, available, asset: String(usd.asset_symbol) };
  }

  async positions(symbols?: readonly string[]): Promise<DeltaPosition[]> {
    const rows = await this.request<Array<Record<string, unknown>>>("/v2/positions/margined", { auth: true });
    if (!Array.isArray(rows)) throw new DeltaRequestError("Delta positions response was invalid", 502);
    const positions = await Promise.all(rows.map(async (p): Promise<DeltaPosition | null> => {
      const size = Number(p.size);
      if (p.size == null || !Number.isFinite(size)) throw new DeltaRequestError("Delta position had an invalid size", 502);
      if (!size) return null;
      const product = p.product && typeof p.product === "object" ? p.product as Record<string, unknown> : {};
      const symbol = String(p.product_symbol ?? product.symbol ?? "");
      if (!symbol) throw new DeltaRequestError("Delta position had no product symbol", 502);
      if (symbols && !symbols.includes(symbol)) return null;
      const entryPrice = Number(p.entry_price);
      const markPrice = p.mark_price == null ? (await this.ticker(symbol)).mark : Number(p.mark_price);
      let unrealizedPnl: number;
      if (p.unrealized_pnl != null) {
        unrealizedPnl = Number(p.unrealized_pnl);
      } else {
        // Margined-position responses may omit P/L and mark; value linear contracts from exchange metadata and ticker.
        let contractValue = Number(product.contract_value);
        if (!(contractValue > 0)) {
          await this.loadProduct(symbol);
          contractValue = specFor(symbol).contractValue;
        }
        unrealizedPnl = (markPrice - entryPrice) * size * contractValue;
      }
      if (!(entryPrice > 0) || !(markPrice > 0) || ![entryPrice, markPrice, unrealizedPnl].every(Number.isFinite)) {
        throw new DeltaRequestError(`Delta position for ${symbol} had invalid prices or P/L`, 502);
      }
      const productId = Number(p.product_id ?? product.id);
      if (!Number.isSafeInteger(productId) || productId <= 0) throw new DeltaRequestError(`Delta position for ${symbol} had no valid product ID`, 502);
      return {
        symbol, productId, direction: size > 0 ? "LONG" : "SHORT", contracts: Math.abs(size),
        entryPrice, markPrice, unrealizedPnl
      };
    }));
    return positions.filter((p): p is DeltaPosition => p !== null);
  }

  /** Most recent account fills (all symbols, newest first), including manual trades. */
  async fills(limit = 30): Promise<DeltaFill[]> {
    const rows = await this.request<Array<Record<string, unknown>>>(`/v2/fills?page_size=${Math.max(1, Math.min(limit, 100))}`, { auth: true });
    if (!Array.isArray(rows)) throw new DeltaRequestError("Delta fills response was invalid", 502);
    return rows.map((f) => {
      const product = f.product && typeof f.product === "object" ? f.product as Record<string, unknown> : {};
      return {
        id: String(f.id), symbol: String(f.product_symbol ?? product.symbol ?? ""), side: f.side === "sell" ? "sell" as const : "buy" as const,
        size: Number(f.size), price: Number(f.price), commission: Number(f.commission ?? 0), notional: Number(f.notional ?? 0),
        order_id: f.order_id == null ? null : String(f.order_id), role: String(f.role ?? ""), time: Date.parse(String(f.created_at)) / 1000
      };
    }).filter((f) => f.symbol && [f.size, f.price, f.time].every(Number.isFinite));
  }

  // ------------------------------------------------------------------ orders
  private log(kind: string, symbol: string, status: string, message: string, extra: { order_id?: string | number | null; price?: number | null; contracts?: number | null } = {}): void {
    this.onLog({
      ts: Date.now() / 1000, kind, symbol, status, message,
      order_id: extra.order_id == null ? null : String(extra.order_id), price: extra.price ?? null, contracts: extra.contracts ?? null
    });
  }

  static clientOrderId(seed: string): string {
    return createHash("sha256").update(seed).digest("hex").slice(0, 32);
  }

  /**
   * Market entry with an exchange-side bracket (SL + final target) so the position is never unprotected.
   * Caller must have claimed the signal for idempotency and obtained Guardian approval.
   */
  async placeEntry(x: { signalId: string; symbol: string; direction: Direction; contracts: number; stop: number; target: number; leverage: number }): Promise<OrderResult> {
    const side = x.direction === "LONG" ? "buy" : "sell";
    const clientOrderId = DeltaBridge.clientOrderId(x.signalId);
    if (!this.isReady()) {
      const msg = this.cfg.environment === "production" ? "Live trading is locked: orders refused on the real-money account." : "Delta is not ready (credentials or connectivity).";
      this.log("order_refused", x.symbol, "refused", msg);
      return { ok: false, message: msg, symbol: x.symbol };
    }
    try {
      const product = await this.loadProduct(x.symbol);
      if (!product.live) throw new DeltaRequestError(`${x.symbol} is not live/operational on Delta India`, 409);
      const spec = specFor(x.symbol);
      const tick = await this.ticker(x.symbol);
      const ref = x.direction === "LONG" ? tick.ask : tick.bid;
      if ((x.direction === "LONG" && !(x.stop < ref && x.target > ref)) || (x.direction === "SHORT" && !(x.stop > ref && x.target < ref))) {
        const msg = `Price ${ref} already beyond the plan (SL ${x.stop}, target ${x.target}); order not sent.`;
        this.log("order_refused", x.symbol, "refused", msg, { price: ref });
        return { ok: false, message: msg, symbol: x.symbol };
      }
      const leverage = Math.max(1, Math.min(x.leverage, product.maxLeverage));
      await this.request(`/v2/products/${product.id}/orders/leverage`, { method: "POST", auth: true, body: { leverage: String(leverage) } });
      const stop = this.tickRound(x.stop, spec.tickSize, x.direction === "LONG" ? "up" : "down");
      const target = this.tickRound(x.target, spec.tickSize, x.direction === "LONG" ? "down" : "up");
      this.log("order_send", x.symbol, "pending", `${side.toUpperCase()} ${x.contracts} @ market · SL ${stop} · TP ${target} · ${leverage}x`, { contracts: x.contracts });
      const order = await this.request<Record<string, unknown>>("/v2/orders", {
        method: "POST", auth: true,
        body: {
          product_id: product.id, size: x.contracts, side, order_type: "market_order", client_order_id: clientOrderId,
          bracket_stop_loss_price: String(stop), bracket_take_profit_price: String(target), bracket_stop_trigger_method: "mark_price"
        }
      });
      const orderId = order.id as number | string | undefined;
      const fillPrice = Number(order.average_fill_price ?? 0) || ref;
      const filled = Number(order.size ?? x.contracts) - Number(order.unfilled_size ?? 0);
      this.log("order_filled", x.symbol, String(order.state ?? "filled"), `Filled ${filled} contracts @ ${fillPrice}`, { order_id: orderId ?? null, price: fillPrice, contracts: filled });
      return { ok: true, message: `Order filled on Delta India (${this.accountLabel()})`, symbol: x.symbol, ...(orderId !== undefined ? { orderId } : {}), clientOrderId, price: roundTo(fillPrice, spec.digits), contracts: filled || x.contracts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log("order_error", x.symbol, "error", msg);
      return { ok: false, message: msg, symbol: x.symbol };
    }
  }

  /** Reduce-only market order (partial or full close). */
  async reduce(symbol: string, direction: Direction, contracts: number, seed: string, reason: string): Promise<OrderResult> {
    try {
      const product = await this.loadProduct(symbol);
      const side = direction === "LONG" ? "sell" : "buy";
      const order = await this.request<Record<string, unknown>>("/v2/orders", {
        method: "POST", auth: true,
        body: { product_id: product.id, size: contracts, side, order_type: "market_order", reduce_only: true, client_order_id: DeltaBridge.clientOrderId(seed) }
      });
      const price = Number(order.average_fill_price ?? 0) || null;
      this.log("reduce", symbol, String(order.state ?? "filled"), `${reason}: closed ${contracts} contracts`, { order_id: order.id as string, price, contracts });
      return { ok: true, message: `${reason}: closed ${contracts} contracts`, symbol, ...(price ? { price } : {}), contracts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log("reduce_error", symbol, "error", msg);
      return { ok: false, message: msg, symbol };
    }
  }

  /** Move the exchange-side stop (break-even / trailing). Tries the position bracket, then the stop order itself. */
  async updateStop(symbol: string, direction: Direction, stop: number, target: number): Promise<boolean> {
    const product = await this.loadProduct(symbol);
    const spec = specFor(symbol);
    const sl = String(this.tickRound(stop, spec.tickSize, direction === "LONG" ? "up" : "down"));
    const tp = String(this.tickRound(target, spec.tickSize, direction === "LONG" ? "down" : "up"));
    try {
      const orders = await this.request<Array<Record<string, unknown>>>(`/v2/orders?product_ids=${product.id}&states=open,pending`, { auth: true });
      const slOrder = Array.isArray(orders) ? orders.find((o) => o.stop_order_type === "stop_loss_order") : undefined;
      if (slOrder) {
        await this.request("/v2/orders", { method: "PUT", auth: true, body: { id: slOrder.id, product_id: product.id, size: slOrder.size, stop_price: sl } });
      } else {
        await this.request("/v2/orders/bracket", {
          method: "POST", auth: true,
          body: { product_id: product.id, stop_loss_order: { order_type: "market_order", stop_price: sl }, take_profit_order: { order_type: "market_order", stop_price: tp }, bracket_stop_trigger_method: "mark_price" }
        });
      }
      this.log("modify_sl", symbol, "ok", `Stop moved to ${sl}`, { price: Number(sl) });
      return true;
    } catch (err) {
      this.log("modify_sl_error", symbol, "error", err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async cancelAll(symbol: string): Promise<void> {
    const product = await this.loadProduct(symbol);
    await this.request("/v2/orders/all", { method: "DELETE", auth: true, body: { product_id: product.id, cancel_limit_orders: true, cancel_stop_orders: true } });
  }

  /** Close the position for a symbol at market and cancel its leftover bracket orders. */
  async closePosition(symbol: string, reason: string): Promise<OrderResult> {
    const pos = (await this.positions([symbol]))[0];
    if (!pos) return { ok: false, message: `No open ${symbol} position on Delta`, symbol };
    const res = await this.reduce(symbol, pos.direction, pos.contracts, `close:${symbol}:${Date.now()}`, reason);
    if (res.ok) await this.cancelAll(symbol).catch(() => undefined);
    return res;
  }

  private tickRound(value: number, tick: number, mode: "up" | "down"): number {
    const steps = value / tick;
    const r = mode === "up" ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
    return roundTo(r * tick, digitsForTick(tick));
  }

  // ------------------------------------------------------------------ health
  async health(symbols: readonly string[]): Promise<DeltaHealth> {
    const issues: DeltaIssue[] = [];
    const products: DeltaHealth["products"] = {};
    let connected = false;
    let ping: number | null = null;
    let account: DeltaHealth["account"] = null;
    const t0 = Date.now();
    try {
      for (const s of symbols) {
        const p = await this.loadProduct(s, true);
        const spec = specFor(s);
        products[s] = { id: p.id, live: p.live, contract_value: spec.contractValue, tick_size: spec.tickSize, max_leverage: p.maxLeverage };
        if (!p.live) issues.push({ code: "PRODUCT_NOT_LIVE", message: `${s} is not operational on Delta India.`, fix: `Remove ${s} from DESK_INSTRUMENTS or wait until trading resumes.` });
      }
      ping = Date.now() - t0;
      connected = true;
    } catch (err) {
      issues.push({ code: "UNREACHABLE", message: err instanceof Error ? err.message : "Delta India API is unreachable.", fix: "Check connectivity to the selected Delta India environment. No synthetic data will be substituted." });
    }
    if (!this.hasCredentials) {
      issues.push({ code: "NO_CREDENTIALS", message: "No complete Delta API credential pair configured for this account.", fix: `Create a key on ${this.cfg.environment === "testnet" ? "demo.delta.exchange" : "india.delta.exchange"} with account read access and set DELTA_${this.cfg.environment === "testnet" ? "DEMO" : "LIVE"}_API_KEY / _SECRET in .env, then restart. Trading permission is only needed to send orders.` });
    } else if (connected) {
      try {
        const w = await this.wallet();
        account = { ...w, equity: w.balance };
      } catch (err) {
        const status = err instanceof DeltaRequestError ? err.status : 0;
        const code = err instanceof DeltaRequestError ? err.code : undefined;
        const ctx = err instanceof DeltaRequestError && err.context && typeof err.context === "object" ? err.context as Record<string, unknown> : {};
        if (code === "ip_not_whitelisted_for_api_key") {
          const ip = typeof ctx.client_ip === "string" ? ctx.client_ip : "this machine's public IP";
          issues.push({
            code: "IP_NOT_WHITELISTED", message: `Delta rejected the API key because requests came from ${ip}, which is not whitelisted.`,
            fix: `Add ${ip} to the key's IP whitelist on ${this.cfg.environment === "testnet" ? "demo.delta.exchange" : "india.delta.exchange"}, or keep DELTA_IP_FAMILY=4 so requests use your whitelisted IPv4 address.`
          });
        } else issues.push({
          code: "AUTH_FAILED", message: `Delta rejected the API key (${err instanceof Error ? err.message : "error"}).`,
          fix: status === 401 || status === 403
            ? "Verify the key/secret, enable Trading permission and whitelist this machine's IP on the Delta API key page."
            : "Retry shortly; if it persists regenerate the API key."
        });
      }
    }
    if (this.cfg.environment === "production") {
      if (!this.allowLiveEnv) issues.push({ code: "LIVE_DISABLED", message: "Real-money trading is hard-disabled.", fix: "Set LIVE_TRADING_CONFIRMED=I_UNDERSTAND_REAL_MONEY in .env and restart to allow unlocking." });
      else if (!this.liveUnlocked) issues.push({ code: "LIVE_LOCKED", message: "Live trading is locked for this session.", fix: `Type "${CONFIRM_PHRASE}" in Settings → Delta to unlock.` });
    }
    this.lastHealth = {
      available: true, connected, authenticated: account !== null, environment: this.cfg.environment, issues,
      checked_at: Date.now() / 1000, ping_ms: ping, live_unlocked: this.liveUnlocked, allow_live_env: this.allowLiveEnv, account, products
    };
    return this.lastHealth;
  }
}
