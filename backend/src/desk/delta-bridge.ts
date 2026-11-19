/**
 * Delta Exchange India bridge for the desk: market data, account sync, bracket orders and position management.
 * Desk requests are pinned to the India demo endpoint; redirects are forbidden.
 */
import { createHash } from "node:crypto";
import { deltaEndpointsByEnvironment, type DeltaEnvironment } from "../exchange/delta-client.js";
import { createDeltaSignature } from "../exchange/signing.js";
import { digitsForTick, FIVE_MIN, roundTo, specFor } from "./market.js";
import type { Bar, Direction } from "./types.js";


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
  account: { balance: number; available: number; equity: null; asset: string } | null;
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
  commission: number | null;
  notional: number | null;
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
  maySubmit?: () => boolean;
}

export class DeltaRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly context?: unknown) {
    super(message);
    this.name = "DeltaRequestError";
  }
}

function numeric(raw: unknown) {
  return typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "") ? Number(raw) : NaN;
}

export class DeltaBridge {
  lastHealth: DeltaHealth;
  private readonly baseUrl: string;
  private readonly products = new Map<string, { id: number; live: boolean; maxLeverage: number; feeBps: number; fetchedAt: number }>();

  constructor(
    private readonly cfg: DeltaBridgeConfig,
    private readonly onLog: (row: ExecLogRow) => void = () => undefined,
    private readonly fetcher: typeof fetch = fetch
  ) {
    if (cfg.environment !== "testnet") throw new Error("Desk accepts only the Delta India testnet.");
    this.baseUrl = deltaEndpointsByEnvironment.testnet.rest;
    this.lastHealth = {
      available: true, connected: false, authenticated: false, environment: cfg.environment, issues: [], checked_at: 0, ping_ms: null,
      live_unlocked: false, allow_live_env: false, account: null, products: {}
    };
  }

  get environment(): DeltaEnvironment {
    return this.cfg.environment;
  }

  get hasCredentials(): boolean {
    return Boolean(this.cfg.apiKey && this.cfg.apiSecret);
  }

  isReady(): boolean {
    const h = this.lastHealth;
    return this.cfg.environment === "testnet" && this.hasCredentials && h.connected && h.authenticated &&
      !h.issues.length && Date.now() / 1000 - h.checked_at >= 0 && Date.now() / 1000 - h.checked_at <= 30;
  }

  // ------------------------------------------------------------------ HTTP
  private async request<T = unknown>(path: string, opts: { method?: "GET" | "POST" | "PUT" | "DELETE"; auth?: boolean; body?: Record<string, unknown> } = {}): Promise<T> {
    const method = opts.method ?? "GET";
    if (method !== "GET" && (path !== "/v2/orders" || method !== "POST" || !opts.auth || !this.isReady() || !this.cfg.maySubmit?.())) {
      throw new DeltaRequestError("Demo execution not authorized", 403);
    }
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
      res = await this.fetcher(`${this.baseUrl}${path}`, { method, redirect: "error", headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(10_000) });
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
    if (json?.success !== true || json.result == null) throw new DeltaRequestError("Invalid Delta response envelope", res.status);
    return json.result as T;
  }

  // ------------------------------------------------------------------ market data
  /** Load product metadata and refresh the shared instrument spec (contract value, tick size, product id). */
  async loadProduct(symbol: string, force = false): Promise<{ id: number; live: boolean; maxLeverage: number; feeBps: number }> {
    const cached = this.products.get(symbol);
    if (cached && !force && Date.now() - cached.fetchedAt < 10 * 60_000) return cached;
    const raw = await this.request<Record<string, unknown>>(`/v2/products/${encodeURIComponent(symbol)}`);
    const id = Number(raw.id);
    const cv = Number(raw.contract_value);
    const tick = Number(raw.tick_size);
    const im = Number(raw.initial_margin);
    if (!Number.isSafeInteger(id) || id <= 0 || ![cv,tick,im].every(n => Number.isFinite(n) && n > 0) || raw.symbol !== symbol) throw new DeltaRequestError(`Delta product ${symbol} metadata was invalid`, 502);
    const spec = specFor(symbol);
    spec.productId = id;
    spec.contractValue = cv;
    spec.tickSize = tick;
    spec.digits = digitsForTick(tick);
    const positionLimit = numeric(raw.position_size_limit);
    if (Number.isSafeInteger(positionLimit) && positionLimit > 0) spec.maxContracts = positionLimit;
    const feeBps = Number(raw.taker_commission_rate) * 1.18 * 10_000;
    const info = { id, live: raw.state === "live" && raw.trading_status === "operational" &&
      raw.contract_type === "perpetual_futures" && raw.notional_type === "vanilla" && raw.is_quanto === false &&
      (raw.quoting_asset as {symbol?:string}|undefined)?.symbol === "USD" && (raw.settling_asset as {symbol?:string}|undefined)?.symbol === "USD" &&
      Number.isSafeInteger(positionLimit) && positionLimit > 0 && raw.taker_commission_rate != null && Number.isFinite(feeBps) && feeBps >= 0,
      feeBps, maxLeverage: Math.floor(100 / im), fetchedAt: Date.now() };
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
        const bar: Bar = { time: Number(r.time), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume) };
        if (Object.values(bar).every(Number.isFinite) && bar.time % FIVE_MIN === 0 && bar.time >= start && bar.time <= end &&
          bar.low > 0 && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close) &&
          r.volume != null && bar.volume >= 0) byTime.set(bar.time, bar);
      }
      remaining -= chunk;
      end = start - 1;
      if (rows.length === 0) break;
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  async ticker(symbol: string): Promise<{ mark: number; bid: number; ask: number; spreadPct: number; timestamp: number }> {
    const r = await this.request<Record<string, unknown>>(`/v2/tickers/${encodeURIComponent(symbol)}`);
    const quotes = (r.quotes ?? {}) as Record<string, unknown>;
    const mark = numeric(r.mark_price);
    const bid = numeric(quotes.best_bid);
    const ask = numeric(quotes.best_ask);
    const timestamp = numeric(r.timestamp) / 1e6;
    const age = Date.now() / 1000 - timestamp;
    if (r.symbol !== symbol || ![mark,bid,ask].every(n => n > 0 && Number.isFinite(n)) || ask < bid || !(age >= 0 && age <= 15)) {
      throw new DeltaRequestError(`Invalid or stale Delta quote for ${symbol}`, 502);
    }
    return { mark, bid, ask, timestamp, spreadPct: (ask - bid) / ((ask + bid) / 2) * 100 };
  }

  // ------------------------------------------------------------------ account
  async wallet(): Promise<{ balance: number; available: number; asset: string }> {
    const rows = await this.request<Array<Record<string, unknown>>>("/v2/wallet/balances", { auth: true });
    if (!Array.isArray(rows)) throw new DeltaRequestError("Delta wallet response was invalid", 502);
    const usd = rows.find((w) => w.asset_symbol === "USD");
    if (!usd) throw new DeltaRequestError("Delta wallet did not contain a USD balance", 502);
    const balance = numeric(usd.balance);
    const available = numeric(usd.available_balance);
    if (usd.balance == null || usd.available_balance == null || !Number.isFinite(balance) || !Number.isFinite(available)) {
      throw new DeltaRequestError("Delta wallet contained invalid balances", 502);
    }

    return { balance, available, asset: String(usd.asset_symbol) };
  }

  async hasWorkingOrders(): Promise<boolean> {
    const rows = await this.request<unknown>("/v2/orders?states=open,pending&page_size=1", { auth: true });
    if (!Array.isArray(rows)) throw new DeltaRequestError("Invalid Delta working-order response", 502);
    return rows.length !== 0;
  }

  async positions(symbols?: readonly string[]): Promise<DeltaPosition[]> {
    const rows = await this.request<Array<Record<string, unknown>>>("/v2/positions/margined", { auth: true });
    if (!Array.isArray(rows)) throw new DeltaRequestError("Delta positions response was invalid", 502);
    const positions = await Promise.all(rows.map(async (p): Promise<DeltaPosition | null> => {
      const size = numeric(p.size);
      if (!Number.isSafeInteger(size)) throw new DeltaRequestError("Delta position had an invalid size", 502);
      if (!size) return null;
      const product = p.product && typeof p.product === "object" ? p.product as Record<string, unknown> : {};
      const symbol = String(p.product_symbol ?? product.symbol ?? "");
      if (!symbol) throw new DeltaRequestError("Delta position had no product symbol", 502);
      if (symbols && !symbols.includes(symbol)) return null;
      const entryPrice = Number(p.entry_price);
      const markPrice = p.mark_price == null ? (await this.ticker(symbol)).mark : Number(p.mark_price);
      let unrealizedPnl: number;
      if (p.unrealized_pnl != null) {
        unrealizedPnl = numeric(p.unrealized_pnl);
      } else {
        // Margined-position responses may omit P/L and mark; value linear contracts from exchange metadata and ticker.
        const meta = await this.loadProduct(symbol);
        if (!meta.live) throw new DeltaRequestError(`Cannot value ${symbol} using linear USD P/L`, 502);
        const contractValue = specFor(symbol).contractValue;
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
    return rows.filter(f => f && (f.side === "buy" || f.side === "sell") && f.id != null).map((f) => {
      const product = f.product && typeof f.product === "object" ? f.product as Record<string, unknown> : {};
      return {
        id: String(f.id), symbol: String(f.product_symbol ?? product.symbol ?? ""), side: f.side === "sell" ? "sell" as const : "buy" as const,
        size: numeric(f.size), price: numeric(f.price), commission: Number.isFinite(numeric(f.commission)) ? numeric(f.commission) : null,
        notional: Number.isFinite(numeric(f.notional)) ? numeric(f.notional) : null,
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
   * Price-bounded IOC limit entry with exchange-side brackets. Never synthesize a fill.
   * Caller must have claimed the signal for idempotency and obtained Guardian approval.
   */
  async placeEntry(x: { signalId: string; symbol: string; direction: Direction; contracts: number; stop: number; target: number; limit: number }): Promise<OrderResult> {
    const side = x.direction === "LONG" ? "buy" : "sell";
    const clientOrderId = DeltaBridge.clientOrderId(x.signalId);
    if (!this.isReady() || !this.cfg.maySubmit?.()) {
      const msg = "Demo execution not armed or healthy.";
      this.log("order_refused", x.symbol, "refused", msg);
      return { ok: false, message: msg, symbol: x.symbol };
    }
    try {
      const product = await this.loadProduct(x.symbol);
      if (!product.live) throw new DeltaRequestError(`${x.symbol} is not live/operational on Delta India`, 409);
      const spec = specFor(x.symbol);
      const stop = this.tickRound(x.stop, spec.tickSize, x.direction === "LONG" ? "up" : "down");
      const target = this.tickRound(x.target, spec.tickSize, x.direction === "LONG" ? "down" : "up");
      if (![stop,target,x.limit].every(n => Number.isFinite(n) && n > 0) || !Number.isSafeInteger(x.contracts) || x.contracts <= 0 ||
        !(side === "buy" ? stop < x.limit && x.limit < target : stop > x.limit && x.limit > target)) throw new Error("Invalid bracket geometry or quantity");
      this.log("order_send", x.symbol, "pending", `${side.toUpperCase()} IOC @ ${x.limit} · SL ${stop} · TP ${target}`, { contracts: x.contracts });
      const order = await this.request<Record<string, unknown>>("/v2/orders", {
        method: "POST", auth: true,
        body: {
          product_id: product.id, size: x.contracts, side, order_type: "limit_order", limit_price: String(x.limit), time_in_force: "ioc", client_order_id: clientOrderId,
          bracket_stop_loss_price: String(stop), bracket_take_profit_price: String(target), bracket_stop_trigger_method: "mark_price"
        }
      });
      const orderId = order.id;
      const fillPrice = Number(order.average_fill_price);
      if (!["number","string"].includes(typeof orderId) || !orderId || order.state !== "closed" || order.client_order_id !== clientOrderId ||
        Number(order.product_id) !== product.id || order.side !== side || Number(order.size) !== x.contracts ||
        numeric(order.unfilled_size) !== 0 || !Number.isFinite(fillPrice) || !(fillPrice > 0)) {
        throw new Error("Fill not confirmed; inspect Delta order history before another submission");
      }
      this.log("order_filled", x.symbol, "filled", `Filled ${x.contracts} contracts @ ${fillPrice}`, { order_id: String(orderId), price: fillPrice, contracts: x.contracts });
      return { ok: true, message: "Delta demo reports a full fill", symbol: x.symbol, orderId: String(orderId), clientOrderId, price: fillPrice, contracts: x.contracts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log("order_error", x.symbol, "error", msg);
      return { ok: false, message: msg, symbol: x.symbol };
    }
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
        account = { ...w, equity: null }; // Wallet alone does not include unrealized position P/L.
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
    this.lastHealth = {
      available: true, connected, authenticated: account !== null, environment: this.cfg.environment, issues,
      checked_at: t0 / 1000, ping_ms: ping, live_unlocked: false, allow_live_env: false, account, products
    };
    return this.lastHealth;
  }
}
