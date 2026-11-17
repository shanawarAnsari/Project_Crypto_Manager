import { afterEach, describe, expect, it, vi } from "vitest";
import type { Candle, LiveChartStatus } from "../domain/types";
import { connectLiveCandles, liveStreamUrl, parseLiveCandle } from "./live-stream";

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) } as MessageEvent);
  }
}

const pushed = {
  type: "candle",
  timeframe: "1m",
  candle: { time: 1_794_914_040, open: "64317", high: "64332", low: "64317", close: "64319.5", volume: "2014" },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("live candle stream client", () => {
  it("builds same-origin ws and wss URLs", () => {
    expect(liveStreamUrl("1m", "http://localhost:3000/dashboard")).toBe("ws://localhost:3000/api/stream?tf=1m");
    expect(liveStreamUrl("15m", "https://sunny.example/")).toBe("wss://sunny.example/api/stream?tf=15m");
  });

  it("accepts only well-formed candles for the subscribed timeframe", () => {
    expect(parseLiveCandle(JSON.stringify(pushed), "1m")).toEqual(pushed.candle);
    expect(parseLiveCandle(JSON.stringify(pushed), "5m")).toBeNull();
    expect(parseLiveCandle(JSON.stringify({ ...pushed, candle: { ...pushed.candle, close: "-1" } }), "1m")).toBeNull();
    expect(parseLiveCandle(JSON.stringify({ ...pushed, candle: { ...pushed.candle, time: 1.5 } }), "1m")).toBeNull();
    expect(parseLiveCandle(JSON.stringify({ type: "subscribed", timeframe: "1m" }), "1m")).toBeNull();
    expect(parseLiveCandle("not-json", "1m")).toBeNull();
    expect(parseLiveCandle(new ArrayBuffer(1), "1m")).toBeNull();
  });

  it("reports status, delivers candles, reconnects with backoff, and stops after dispose", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const statuses: LiveChartStatus[] = [];
    const candles: Candle[] = [];
    const onConnected = vi.fn();
    const dispose = connectLiveCandles(
      "1m",
      { onStatus: (status) => statuses.push(status), onCandle: (candle) => candles.push(candle), onConnected },
      {
        baseUrl: "http://localhost:3000/",
        socketFactory: (url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      },
    );
    expect(sockets[0]?.url).toBe("ws://localhost:3000/api/stream?tf=1m");
    sockets[0]!.onopen?.();
    sockets[0]!.receive(pushed);
    sockets[0]!.receive({ ...pushed, timeframe: "5m" });
    expect(candles).toEqual([pushed.candle]);
    expect(onConnected).toHaveBeenCalledTimes(1);

    sockets[0]!.onerror?.();
    expect(statuses).toEqual(["connecting", "live", "stale"]);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.close();
    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    sockets[2]!.onopen?.();
    expect(onConnected).toHaveBeenCalledTimes(2);

    dispose();
    expect(sockets[2]!.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(3);
    expect(statuses.at(-1)).toBe("live");
  });
});
