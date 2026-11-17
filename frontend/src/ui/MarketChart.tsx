import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { Candle, LiveChartStatus, Position, Timeframe, Trade } from "../domain/types";
import { CHART_TIMEFRAMES } from "./live-candles";
import { EmptyState, Panel, StatusPill } from "./Status";
import { formatMoney, formatNumber, pnlClass } from "./format";

const timeframes = CHART_TIMEFRAMES;

function ema(candles: Candle[], period: number) {
  const factor = 2 / (period + 1);
  let average: number | undefined;
  return candles.flatMap((candle) => {
    const close = Number(candle.close);
    if (!Number.isFinite(close)) return [];
    average = average === undefined ? close : close * factor + average * (1 - factor);
    return [{ time: candle.time as UTCTimestamp, value: average }];
  });
}

type ChartSeries = {
  chart: IChartApi;
  price: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  ema20: ISeriesApi<"Line">;
  ema50: ISeriesApi<"Line">;
  markers: ISeriesMarkersPluginApi<Time>;
};

function toBar(candle: Candle) {
  return {
    time: candle.time as UTCTimestamp,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
  };
}

function toVolume(candle: Candle) {
  return {
    time: candle.time as UTCTimestamp,
    value: Number(candle.volume),
    color: Number(candle.close) >= Number(candle.open)
      ? "rgba(53, 211, 154, 0.32)"
      : "rgba(240, 113, 120, 0.32)",
  };
}

/** Renders once per mount and then applies live candle updates in place so zoom and scroll survive. */
function ChartCanvas({
  candles,
  trades,
  positions,
  markPrice,
  ema20,
  ema50,
}: {
  candles: Candle[];
  trades: Trade[];
  positions: Position[];
  markPrice: string | null;
  ema20: boolean;
  ema50: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<ChartSeries | null>(null);
  const lastRenderedTime = useRef<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      width: host.clientWidth,
      height: 330,
      layout: {
        background: { type: ColorType.Solid, color: "#10161e" },
        textColor: "#8794a5",
        fontFamily: "Inter, ui-sans-serif, system-ui",
      },
      grid: {
        vertLines: { color: "#1c2631" },
        horzLines: { color: "#1c2631" },
      },
      rightPriceScale: { borderColor: "#26313e" },
      timeScale: { borderColor: "#26313e", timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "#52647a" }, horzLine: { color: "#52647a" } },
    });
    const price = chart.addSeries(CandlestickSeries, {
      upColor: "#35d39a",
      downColor: "#f07178",
      borderUpColor: "#35d39a",
      borderDownColor: "#f07178",
      wickUpColor: "#35d39a",
      wickDownColor: "#f07178",
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const lineOptions = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false };
    const ema20Series = chart.addSeries(LineSeries, { ...lineOptions, color: "#f0b968" });
    const ema50Series = chart.addSeries(LineSeries, { ...lineOptions, color: "#60a5fa" });
    seriesRef.current = {
      chart,
      price,
      volume,
      ema20: ema20Series,
      ema50: ema50Series,
      markers: createSeriesMarkers(price, []),
    };
    lastRenderedTime.current = null;

    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) chart.applyOptions({ width });
    });
    resizeObserver.observe(host);
    return () => {
      resizeObserver.disconnect();
      seriesRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || candles.length === 0) return;
    const ema20Points = ema(candles, 20);
    const ema50Points = ema(candles, 50);
    const lastTime = lastRenderedTime.current;
    if (lastTime === null) {
      series.price.setData(candles.map(toBar));
      series.volume.setData(candles.map(toVolume));
      series.ema20.setData(ema20Points);
      series.ema50.setData(ema50Points);
      series.chart.timeScale().fitContent();
    } else {
      for (const candle of candles) {
        if (candle.time < lastTime) continue;
        series.price.update(toBar(candle));
        series.volume.update(toVolume(candle));
      }
      for (const point of ema20Points) if (point.time >= lastTime) series.ema20.update(point);
      for (const point of ema50Points) if (point.time >= lastTime) series.ema50.update(point);
    }
    lastRenderedTime.current = candles[candles.length - 1]?.time ?? lastTime;
  }, [candles]);

  useEffect(() => {
    seriesRef.current?.ema20.applyOptions({ visible: ema20 });
    seriesRef.current?.ema50.applyOptions({ visible: ema50 });
  }, [ema20, ema50]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const lines: IPriceLine[] = [];
    const addLine = (price: number, color: string, lineStyle: LineStyle, title: string) => {
      if (Number.isFinite(price) && price > 0) {
        lines.push(series.price.createPriceLine({ price, color, lineWidth: 1, lineStyle, axisLabelVisible: true, title }));
      }
    };
    if (markPrice) addLine(Number(markPrice), "#60a5fa", LineStyle.Dashed, "MARK");
    for (const position of positions) {
      addLine(
        Number(position.entryPrice),
        position.side === "long" ? "#35d39a" : "#f07178",
        LineStyle.Dotted,
        `${position.side.toUpperCase()} ENTRY`,
      );
      if (position.stopPrice !== null) addLine(Number(position.stopPrice), "#f0b968", LineStyle.Dashed, "STOP");
      if (position.takeProfitPrice !== null) addLine(Number(position.takeProfitPrice), "#35d39a", LineStyle.Dashed, "TARGET");
    }
    return () => {
      for (const line of lines) series.price.removePriceLine(line);
    };
  }, [markPrice, positions]);

  useEffect(() => {
    seriesRef.current?.markers.setMarkers(
      trades.map((trade) => ({
        time: trade.timestamp as UTCTimestamp,
        position: trade.side === "buy" ? ("belowBar" as const) : ("aboveBar" as const),
        color: trade.side === "buy" ? "#35d39a" : "#f07178",
        shape: trade.side === "buy" ? ("arrowUp" as const) : ("arrowDown" as const),
        text: `${trade.side.toUpperCase()} ${trade.quantity}`,
      })),
    );
  }, [trades]);

  return <div aria-label="BTC candlestick chart" className="h-[330px] w-full" ref={hostRef} />;
}

const liveTone = { live: "green", connecting: "neutral", stale: "amber" } as const;

export function MarketChart({
  candles,
  trades,
  positions,
  markPrice,
  timeframe,
  onTimeframeChange,
  loading,
  error,
  onRetry,
  liveStatus = "connecting",
}: {
  candles: Candle[] | null;
  trades: Trade[];
  positions: Position[];
  markPrice: string | null;
  timeframe: Timeframe;
  onTimeframeChange: (timeframe: Timeframe) => void;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  liveStatus?: LiveChartStatus;
}) {
  const [ema20, setEma20] = useState(true);
  const [ema50, setEma50] = useState(false);
  return (
    <Panel
      title="BTC-PERP · PRICE ACTION"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <label className="indicator-toggle">
            <input checked={ema20} onChange={(event) => setEma20(event.target.checked)} type="checkbox" />
            <span className="text-amber-300">EMA 20</span>
          </label>
          <label className="indicator-toggle">
            <input checked={ema50} onChange={(event) => setEma50(event.target.checked)} type="checkbox" />
            <span className="text-blue-300">EMA 50</span>
          </label>
        </div>
      }
    >
      <div className="flex items-center justify-between border-b border-terminal-border px-4 py-2">
        <div className="flex items-center gap-1">
          {timeframes.map((value) => (
            <button
              aria-pressed={timeframe === value}
              className={`timeframe-button ${timeframe === value ? "timeframe-active" : ""}`}
              key={value}
              onClick={() => onTimeframeChange(value)}
              type="button"
            >
              {value}
            </button>
          ))}
        </div>
        <StatusPill tone={liveTone[liveStatus]}>
          {liveStatus === "live" ? "● LIVE" : liveStatus === "stale" ? "STALE" : "CONNECTING"}
        </StatusPill>
      </div>
      {positions.length > 0 && <section aria-label="Current position PnL" className="space-y-2 border-b border-terminal-border p-3 text-xs">
        <p className="text-terminal-muted">Exchange unrealized PnL (USD), refreshed every 5 seconds; not net realized profit.</p>
        {positions.map((position) => <div key={position.id}>
          <strong>{position.symbol} {position.side.toUpperCase()} / {position.quantity} contracts</strong>
          <span className={`ml-3 ${pnlClass(position.unrealizedPnl)}`}>Running PnL: {formatMoney(position.unrealizedPnl)}</span>
          <p>Entry: {formatNumber(position.entryPrice)} | Stop: {position.stopPrice === null ? "Unverified" : formatNumber(position.stopPrice)} |
            {" "}Target: {position.takeProfitPrice === null ? "Unverified" : formatNumber(position.takeProfitPrice)}</p>
        </div>)}
      </section>}
      {loading ? (
        <div className="chart-message" role="status">Loading {timeframe} candles…</div>
      ) : error ? (
        <div className="chart-message" role="alert">
          <p>{error}</p>
          <button className="text-link mt-2" onClick={onRetry} type="button">Retry candles</button>
        </div>
      ) : candles?.length ? (
        <ChartCanvas
          candles={candles}
          ema20={ema20}
          ema50={ema50}
          key={timeframe}
          markPrice={markPrice}
          positions={positions}
          trades={trades}
        />
      ) : (
        <div className="chart-message"><EmptyState>No candles are available for this timeframe.</EmptyState></div>
      )}
    </Panel>
  );
}
