import type { Candle, LiveChartStatus, Timeframe } from "../domain/types";

export const LIVE_RECONNECT_MIN_MS = 1_000;
export const LIVE_RECONNECT_MAX_MS = 15_000;

export interface LiveCandleHandlers {
  onCandle: (candle: Candle) => void;
  onStatus: (status: LiveChartStatus) => void;
  /** Called after every (re)connect so the caller can backfill candles missed while disconnected. */
  onConnected?: () => void;
}

export interface LiveCandleOptions {
  socketFactory?: (url: string) => WebSocket;
  baseUrl?: string;
}

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

export function liveStreamUrl(timeframe: Timeframe, baseUrl = window.location.href): string {
  const url = new URL("/api/stream", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = `?tf=${encodeURIComponent(timeframe)}`;
  return url.toString();
}

export function parseLiveCandle(data: unknown, timeframe: Timeframe): Candle | null {
  if (typeof data !== "string") return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  const { type, timeframe: received, candle } = message as Record<string, unknown>;
  if (type !== "candle" || received !== timeframe || !candle || typeof candle !== "object") return null;
  const { time, open, high, low, close, volume } = candle as Record<string, unknown>;
  if (typeof time !== "number" || !Number.isSafeInteger(time) || time <= 0) return null;
  const prices = [open, high, low, close, volume];
  if (!prices.every((value): value is string => typeof value === "string" && DECIMAL.test(value))) return null;
  const [o, h, l, c, v] = prices as [string, string, string, string, string];
  return { time, open: o, high: h, low: l, close: c, volume: v };
}

/** Subscribes to pushed candles for one timeframe, reconnecting with exponential backoff. Returns a disposer. */
export function connectLiveCandles(
  timeframe: Timeframe,
  handlers: LiveCandleHandlers,
  options: LiveCandleOptions = {},
): () => void {
  const factory = options.socketFactory ?? ((url: string) => new WebSocket(url));
  const url = liveStreamUrl(timeframe, options.baseUrl);
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let delay = LIVE_RECONNECT_MIN_MS;
  let disposed = false;

  const connect = () => {
    if (disposed) return;
    handlers.onStatus("connecting");
    const current = factory(url);
    socket = current;
    current.onopen = () => {
      if (disposed || socket !== current) return;
      delay = LIVE_RECONNECT_MIN_MS;
      handlers.onStatus("live");
      handlers.onConnected?.();
    };
    current.onmessage = (event: MessageEvent) => {
      if (disposed || socket !== current) return;
      const candle = parseLiveCandle(event.data, timeframe);
      if (candle) handlers.onCandle(candle);
    };
    current.onclose = () => {
      if (disposed || socket !== current) return;
      socket = null;
      handlers.onStatus("stale");
      reconnectTimer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, LIVE_RECONNECT_MAX_MS);
    };
    current.onerror = () => current.close();
  };

  connect();
  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
  };
}
