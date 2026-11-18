import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setState } from "../store";
import type { CycleSummary } from "../types";
import { SweepChart } from "./SweepChart";

const chartData = vi.hoisted(() => [] as { series: string; points: unknown[] }[]);

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: "candles", HistogramSeries: "volume", LineSeries: "line",
  ColorType: { Solid: "solid" }, LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 },
  createSeriesMarkers: () => ({ setMarkers: vi.fn() }),
  createChart: () => {
    let disposed = false;
    const makeSeries = (name: string) => ({
      setData: (points: unknown[]) => chartData.push({ series: name, points }),
      update: vi.fn(), createPriceLine: () => ({}),
      removePriceLine: () => { if (disposed) throw new Error("Object is disposed"); }
    });
    return {
      addSeries: (name: string) => makeSeries(name),
      addPane: () => ({ setHeight: vi.fn(), addSeries: (name: string) => makeSeries(name) }),
      timeScale: () => ({ scrollToRealTime: vi.fn() }),
      applyOptions: vi.fn(), remove: () => { disposed = true; }
    };
  }
}));

beforeEach(() => {
  chartData.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("live chart lifecycle", () => {
  it("switches instruments and unmounts without removing lines from a disposed chart", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const candle = { time: 300, open: 100, high: 102, low: 99, close: 101, volume: 1 };
    const cycle: CycleSummary = {
      instrument: "BTCUSD", cycle_id: "1", outcome: "none", ts: 1, setup: null, decision: null, checks: [],
      levels: [{ name: "PDH", price: 102, side: "high", strength: 1 }], trace: [], execution: {}
    };
    setState({
      instrument: "BTCUSD", instruments: ["BTCUSD", "ETHUSD"], positions: [], dataSource: "delta",
      candles: { BTCUSD: [candle], ETHUSD: [candle] }, candleHistoryLoaded: { BTCUSD: true, ETHUSD: true },
      lastCycle: { BTCUSD: cycle, ETHUSD: { ...cycle, instrument: "ETHUSD" } }
    });
    const view = render(<SweepChart />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "ETHUSD" }))).not.toThrow();
    expect(screen.getByRole("button", { name: "ETHUSD" })).toHaveAttribute("aria-pressed", "true");
    expect(() => view.unmount()).not.toThrow();
  });

  it("plots seeded EMA 9/21 lines and volume bars", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const candles = Array.from({ length: 25 }, (_, i) => ({
      time: 300 + i * 300, open: 99 + i, high: 101 + i, low: 98 + i, close: 100 + i, volume: i + 1
    }));
    setState({
      instrument: "BTCUSD", instruments: ["BTCUSD"], positions: [], dataSource: "delta",
      candles: { BTCUSD: candles }, candleHistoryLoaded: { BTCUSD: true }
    });

    render(<SweepChart />);

    const lines = chartData.filter((entry) => entry.series === "line");
    const ema9 = lines[0]!.points as { time: number; value: number }[];
    const ema21 = lines[1]!.points as { time: number; value: number }[];
    const volume = chartData.find((entry) => entry.series === "volume")!.points;
    expect(ema9).toHaveLength(17);
    expect(ema9[0]).toEqual({ time: 2700, value: 104 });
    expect(ema21).toHaveLength(5);
    expect(ema21[0]).toEqual({ time: 6300, value: 110 });
    expect(volume).toHaveLength(25);
    expect(screen.getByText("EMA 9")).toBeInTheDocument();
    expect(screen.getByText("EMA 21")).toBeInTheDocument();
    expect(screen.getByText("volume")).toBeInTheDocument();
  });
});
