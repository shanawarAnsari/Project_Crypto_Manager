import { EventEmitter } from "node:events";
import Decimal from "decimal.js";
import WebSocket from "ws";
import { CHART_TIMEFRAMES, TIMEFRAME_SECONDS, type Candle, type ChartTimeframe } from "../domain.js";
import { deltaEndpointsByEnvironment, type DeltaEnvironment } from "./delta-client.js";

const STREAM_SYMBOL = "BTCUSD";

export interface StreamOptions {
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  heartbeatMs?: number;
  socketFactory?: (url: string) => WebSocket;
  environment?: DeltaEnvironment;
}

export interface StreamTicker {
  symbol: string;
  markPrice: string;
  fundingRate: string | null;
  receivedAt: number;
}

export interface StreamCandle {
  symbol: string;
  timeframe: ChartTimeframe;
  candle: Candle;
}

export class DeltaMarketStream extends EventEmitter {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectDelay: number;
  private closed = false;
  private lastPongAt = Date.now();
  private readonly factory: (url: string) => WebSocket;

  constructor(private readonly options: StreamOptions = {}) {
    super();
    this.reconnectDelay = options.reconnectMinMs ?? 500;
    this.factory = options.socketFactory ?? ((url) => new WebSocket(url));
  }

  connect(): void {
    if (this.closed || this.socket) return;
    const socket = this.factory(deltaEndpointsByEnvironment[this.options.environment ?? "testnet"].socket);
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectDelay = this.options.reconnectMinMs ?? 500;
      this.lastPongAt = Date.now();
      socket.send(JSON.stringify({
        type: "subscribe",
        payload: {
          channels: [
            { name: "v2/ticker", symbols: [STREAM_SYMBOL] },
            ...CHART_TIMEFRAMES.map((timeframe) => ({ name: `candlestick_${timeframe}`, symbols: [STREAM_SYMBOL] }))
          ]
        }
      }));
      this.startHeartbeat(socket);
      this.emit("connected");
    });
    socket.on("pong", () => {
      this.lastPongAt = Date.now();
      this.emit("heartbeat");
    });
    socket.on("message", (data) => {
      try {
        const message: unknown = JSON.parse(data.toString());
        const ticker = parseTicker(message);
        if (ticker) this.emit("ticker", ticker);
        const candle = parseStreamCandle(message);
        if (candle) this.emit("candle", candle);
        this.emit("message", message);
      } catch {
        this.emit("streamError", "Delta India market stream returned invalid JSON");
      }
    });
    socket.on("error", () => this.emit("streamError", "Delta India market stream error"));
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.stopHeartbeat();
      this.emit("disconnected");
      this.scheduleReconnect();
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  private startHeartbeat(socket: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const heartbeatMs = this.options.heartbeatMs ?? 15_000;
      if (Date.now() - this.lastPongAt > heartbeatMs * 2) {
        socket.terminate();
        return;
      }
      socket.ping();
    }, this.options.heartbeatMs ?? 15_000);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectTimer.unref();
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.options.reconnectMaxMs ?? 30_000);
  }
}

function positiveDecimal(value: unknown, allowZero = false): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const parsed = new Decimal(String(value));
    if (!parsed.isFinite() || parsed.lt(0) || (!allowZero && parsed.eq(0))) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Accepts the compact Delta India feed (`o/h/l/c/v/sy/res/ts`) and the legacy verbose
 * form (`open/high/low/close/volume/symbol/resolution/candle_start_time`). Timestamps are microseconds.
 */
export function parseStreamCandle(message: unknown): StreamCandle | null {
  if (typeof message !== "object" || message === null) return null;
  const raw = message as Record<string, unknown>;
  if (typeof raw.type !== "string" || !raw.type.startsWith("candlestick_")) return null;
  const timeframe = (raw.res ?? raw.resolution ?? raw.type.slice("candlestick_".length)) as ChartTimeframe;
  if (!CHART_TIMEFRAMES.includes(timeframe)) return null;
  if ((raw.sy ?? raw.symbol) !== STREAM_SYMBOL) return null;
  const open = positiveDecimal(raw.o ?? raw.open);
  const high = positiveDecimal(raw.h ?? raw.high);
  const low = positiveDecimal(raw.l ?? raw.low);
  const close = positiveDecimal(raw.c ?? raw.close);
  const volume = positiveDecimal(raw.v ?? raw.volume ?? 0, true);
  if (!open || !high || !low || !close || volume === null) return null;
  const high$ = new Decimal(high);
  const low$ = new Decimal(low);
  if (high$.lt(low$) || high$.lt(open) || high$.lt(close) || low$.gt(open) || low$.gt(close)) return null;
  const intervalMs = TIMEFRAME_SECONDS[timeframe] * 1000;
  // Delta weekly candles open Monday 00:00 UTC; the Unix epoch was a Thursday (4 days earlier).
  const offsetMs = timeframe === "1w" ? 4 * 86_400_000 : 0;
  let startMs: number;
  if (raw.candle_start_time !== undefined) {
    startMs = Math.floor(Number(raw.candle_start_time) / 1000);
  } else {
    const updateMs = Math.floor(Number(raw.ts ?? raw.timestamp) / 1000);
    startMs = Math.floor((updateMs - offsetMs) / intervalMs) * intervalMs + offsetMs;
  }
  if (!Number.isSafeInteger(startMs) || startMs <= 0 || startMs % 60_000 !== 0) return null;
  return {
    symbol: STREAM_SYMBOL,
    timeframe,
    candle: { timestamp: startMs, open, high, low, close, volume }
  };
}

function parseTicker(message: unknown): StreamTicker | null {
  if (typeof message !== "object" || message === null) return null;
  const envelope = message as Record<string, unknown>;
  if (envelope.type !== "ticker" || typeof envelope.ticker !== "object" || envelope.ticker === null) return null;
  const ticker = envelope.ticker as Record<string, unknown>;
  if (ticker.symbol !== "BTCUSD") return null;
  const rawPrice = ticker.mark_price ?? ticker.close;
  if (typeof rawPrice !== "string" && typeof rawPrice !== "number") return null;
  const price = new Decimal(String(rawPrice));
  if (!price.isFinite() || price.lte(0)) return null;
  const rawFunding = ticker.funding_rate;
  let fundingRate: string | null = null;
  if (typeof rawFunding === "string" || typeof rawFunding === "number") {
    const funding = new Decimal(String(rawFunding));
    if (!funding.isFinite()) return null;
    fundingRate = funding.toString();
  }
  return {
    symbol: "BTCUSD",
    markPrice: price.toString(),
    fundingRate,
    receivedAt: Date.now()
  };
}
