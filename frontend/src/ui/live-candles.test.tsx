import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { Candle, LiveChartStatus } from "../domain/types";
import type { LiveCandleHandlers } from "../api/live-stream";
import { mergeCandles, toStrategyTimeframe } from "./live-candles";

const live = vi.hoisted(() => ({ handlers: [] as LiveCandleHandlers[], timeframes: [] as string[] }));

vi.mock("../api/live-stream", () => ({
  connectLiveCandles: (timeframe: string, handlers: LiveCandleHandlers) => {
    live.timeframes.push(timeframe);
    live.handlers.push(handlers);
    return () => undefined;
  },
}));

vi.mock("./MarketChart", () => ({
  MarketChart: ({ candles, liveStatus }: { candles: Candle[] | null; liveStatus: LiveChartStatus }) => (
    <div>
      <span data-testid="live-status">{liveStatus}</span>
      <span data-testid="last-close">{candles?.at(-1)?.close ?? "none"}</span>
      <span data-testid="candle-count">{candles?.length ?? 0}</span>
    </div>
  ),
}));

function candle(time: number, close: string): Candle {
  return { time, open: "100", high: "110", low: "90", close, volume: "1" };
}

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

afterEach(() => {
  cleanup();
  live.handlers.length = 0;
  live.timeframes.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("live candle merging", () => {
  it("replaces the forming candle, appends new candles, and caps history", () => {
    const history = [candle(60, "100"), candle(120, "101")];
    expect(mergeCandles(history, [candle(120, "105"), candle(180, "106")])).toEqual([
      candle(60, "100"),
      candle(120, "105"),
      candle(180, "106"),
    ]);
    expect(mergeCandles(history, [candle(180, "106")], 2)).toEqual([candle(120, "101"), candle(180, "106")]);
  });

  it("keeps the same array reference when an update changes nothing", () => {
    const history = [candle(60, "100")];
    expect(mergeCandles(history, [])).toBe(history);
    expect(mergeCandles(history, [candle(60, "100")])).toBe(history);
  });

  it("maps chart-only intraday timeframes to the 1h strategy timeframe", () => {
    expect(toStrategyTimeframe("1m")).toBe("1h");
    expect(toStrategyTimeframe("30m")).toBe("1h");
    expect(toStrategyTimeframe("4h")).toBe("4h");
    expect(toStrategyTimeframe("1w")).toBe("1w");
  });
});

describe("live chart streaming", () => {
  it("merges pushed candles, keeps ticks received during the history load, and backfills after reconnect", async () => {
    let resolveHistory: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/dashboard") return json({ message: "offline" }, 503);
      if (url === "/api/candles?tf=5m") return new Promise<Response>((resolve) => { resolveHistory = resolve; });
      if (url === "/api/candles?tf=5m&limit=50") return json({ candles: [candle(10_800, "107"), candle(14_400, "108")] });
      return json({ message: "unexpected" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await waitFor(() => expect(live.handlers).toHaveLength(1));
    const handlers = live.handlers[0]!;
    expect(live.timeframes).toEqual(["5m"]);
    act(() => {
      handlers.onStatus("live");
      handlers.onConnected?.();
      handlers.onCandle(candle(7200, "102"));
    });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/candles?tf=5m&limit=50")).toBe(false);

    resolveHistory(new Response(JSON.stringify({ candles: [candle(3600, "100"), candle(7200, "101")] })));
    await waitFor(() => expect(screen.getByTestId("last-close")).toHaveTextContent("102"));
    expect(screen.getByTestId("live-status")).toHaveTextContent("live");

    act(() => handlers.onCandle(candle(10_800, "103")));
    expect(screen.getByTestId("last-close")).toHaveTextContent("103");
    expect(screen.getByTestId("candle-count")).toHaveTextContent("3");

    act(() => handlers.onStatus("stale"));
    expect(screen.getByTestId("live-status")).toHaveTextContent("stale");
    act(() => {
      handlers.onStatus("live");
      handlers.onConnected?.();
    });
    await waitFor(() => expect(screen.getByTestId("last-close")).toHaveTextContent("108"));
    expect(screen.getByTestId("candle-count")).toHaveTextContent("4");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/candles?tf=5m")).toHaveLength(1);
  });
});
