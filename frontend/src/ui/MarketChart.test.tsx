import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketChart } from "./MarketChart";
import type { Position } from "../domain/types";

const chart = vi.hoisted(() => ({
  createPriceLine: vi.fn((options: unknown) => options),
  removePriceLine: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: "candles", HistogramSeries: "volume", LineSeries: "line",
  ColorType: { Solid: "solid" }, LineStyle: { Dashed: 2, Dotted: 1 },
  createSeriesMarkers: () => ({ setMarkers: vi.fn() }),
  createChart: () => ({
    addSeries: () => ({ setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn(),
      createPriceLine: chart.createPriceLine, removePriceLine: chart.removePriceLine }),
    priceScale: () => ({ applyOptions: vi.fn() }),
    timeScale: () => ({ fitContent: vi.fn() }),
    applyOptions: vi.fn(), remove: chart.remove,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const position: Position = { id: "owned", symbol: "BTCUSD", side: "long", quantity: "1",
  entryPrice: "100000", markPrice: "100100", unrealizedPnl: "0.1", leverage: "1",
  stopPrice: "99000", takeProfitPrice: "102000" };
const props = {
  candles: [{ time: 1, open: "100000", high: "100100", low: "99900", close: "100000", volume: "1" }],
  trades: [], positions: [position], markPrice: "100100", timeframe: "5m" as const,
  onTimeframeChange: vi.fn(), loading: false, error: null, onRetry: vi.fn(),
};

describe("confirmed position chart and PnL", () => {
  it("draws entry, stop and target and refreshes exchange PnL without rebuilding the chart", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const view = render(<MarketChart {...props} />);
    expect(chart.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ price: 100000, title: "LONG ENTRY" }));
    expect(chart.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ price: 99000, title: "STOP" }));
    expect(chart.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ price: 102000, title: "TARGET" }));
    expect(screen.getByRole("region", { name: "Current position PnL" })).toHaveTextContent("Running PnL: $0.10");
    view.rerender(<MarketChart {...props} positions={[{ ...position, unrealizedPnl: "-0.25" }]} />);
    expect(screen.getByRole("region", { name: "Current position PnL" })).toHaveTextContent("Running PnL: -$0.25");
    expect(chart.remove).not.toHaveBeenCalled();
    view.rerender(<MarketChart {...props} positions={[]} />);
    expect(screen.queryByRole("region", { name: "Current position PnL" })).not.toBeInTheDocument();
    expect(chart.removePriceLine).toHaveBeenCalled();
  });
  it("does not invent missing protection and still shows PnL if candle loading fails", () => {
    render(<MarketChart {...props} candles={null} error="Candles unavailable"
      positions={[{ ...position, stopPrice: null, takeProfitPrice: null }]} />);
    expect(screen.getByRole("region", { name: "Current position PnL" })).toHaveTextContent("Stop: Unverified");
    expect(screen.getByRole("region", { name: "Current position PnL" })).toHaveTextContent("Target: Unverified");
    expect(chart.createPriceLine).not.toHaveBeenCalled();
  });
});
