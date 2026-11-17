import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { CHART_TIMEFRAMES, type Candle, type ChartTimeframe } from "../domain.js";

export const LIVE_STREAM_PATH = "/api/stream";
const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

/** Message relayed from the worker process to the API process over IPC. */
export interface WorkerCandleMessage {
  type: "candle";
  timeframe: ChartTimeframe;
  candle: Candle;
}

export interface LiveCandleEvent {
  type: "candle";
  timeframe: ChartTimeframe;
  candle: { time: number; open: string; high: string; low: string; close: string; volume: string };
}

export function parseWorkerCandleMessage(value: unknown): WorkerCandleMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type !== "candle" || !CHART_TIMEFRAMES.includes(message.timeframe as ChartTimeframe)) return null;
  const candle = message.candle as Record<string, unknown> | null | undefined;
  if (!candle || typeof candle !== "object") return null;
  const { timestamp, open, high, low, close, volume } = candle;
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  const prices = [open, high, low, close, volume];
  if (!prices.every((field): field is string => typeof field === "string" && DECIMAL.test(field))) return null;
  const [o, h, l, c, v] = prices as [string, string, string, string, string];
  return { type: "candle", timeframe: message.timeframe as ChartTimeframe, candle: { timestamp, open: o, high: h, low: l, close: c, volume: v } };
}

export function toLiveCandleEvent(message: WorkerCandleMessage): LiveCandleEvent {
  const { timestamp, ...prices } = message.candle;
  return { type: "candle", timeframe: message.timeframe, candle: { time: Math.floor(timestamp / 1000), ...prices } };
}

/**
 * Pushes live chart candles to browsers over WebSocket. Each client subscribes to exactly one
 * chart timeframe via `?tf=`; inbound client messages are ignored.
 */
export class LiveCandleHub {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  private readonly subscriptions = new Map<WebSocket, ChartTimeframe>();
  private readonly alive = new WeakSet<WebSocket>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(heartbeatMs = 30_000) {
    this.heartbeat = setInterval(() => this.checkHeartbeats(), heartbeatMs);
    this.heartbeat.unref();
  }

  attach(httpServer: Server): void {
    httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== LIVE_STREAM_PATH) {
        socket.destroy();
        return;
      }
      const timeframe = url.searchParams.get("tf");
      if (!CHART_TIMEFRAMES.includes(timeframe as ChartTimeframe)) {
        socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.server.handleUpgrade(request, socket, head, (client) => this.register(client, timeframe as ChartTimeframe));
    });
  }

  broadcast(event: LiveCandleEvent): void {
    const payload = JSON.stringify(event);
    for (const [client, timeframe] of this.subscriptions) {
      if (timeframe === event.timeframe && client.readyState === client.OPEN) client.send(payload);
    }
  }

  get clientCount(): number {
    return this.subscriptions.size;
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const client of this.subscriptions.keys()) client.terminate();
    this.subscriptions.clear();
    this.server.close();
  }

  private register(client: WebSocket, timeframe: ChartTimeframe): void {
    this.subscriptions.set(client, timeframe);
    this.alive.add(client);
    client.on("pong", () => this.alive.add(client));
    client.on("close", () => this.subscriptions.delete(client));
    client.on("error", () => client.terminate());
    client.send(JSON.stringify({ type: "subscribed", timeframe }));
  }

  private checkHeartbeats(): void {
    for (const client of this.subscriptions.keys()) {
      if (!this.alive.has(client)) {
        client.terminate();
        this.subscriptions.delete(client);
        continue;
      }
      this.alive.delete(client);
      client.ping();
    }
  }
}
