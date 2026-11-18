import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, HistogramSeries, LineSeries, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { loadCandles, pushToast, setState, useDesk } from "../store";
import type { Candle, CycleSummary, Position } from "../types";

const toBar = (c: Candle) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });

function emaData(candles: readonly Candle[], period: number): { time: UTCTimestamp; value: number }[] {
  if (candles.length < period) return [];
  const multiplier = 2 / (period + 1);
  let value = candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;
  const data = [{ time: candles[period - 1]!.time as UTCTimestamp, value }];
  for (let i = period; i < candles.length; i += 1) {
    value = candles[i]!.close * multiplier + value * (1 - multiplier);
    data.push({ time: candles[i]!.time as UTCTimestamp, value });
  }
  return data;
}

function Canvas({ candles, cycle, positions, digits }: { candles: Candle[]; cycle: CycleSummary | undefined; positions: Position[]; digits: number }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<{
    chart: IChartApi;
    series: ISeriesApi<"Candlestick">;
    ema9: ISeriesApi<"Line">;
    ema21: ISeriesApi<"Line">;
    volume: ISeriesApi<"Histogram">;
    markers: ISeriesMarkersPluginApi<Time>;
  } | null>(null);
  const lastTime = useRef<number | null>(null);
  const firstTime = useRef<number | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const chart = createChart(el, {
      width: el.clientWidth, height: 380,
      layout: { background: { type: ColorType.Solid, color: "#10161e" }, textColor: "#8794a5", fontFamily: "Inter, ui-sans-serif, system-ui" },
      grid: { vertLines: { color: "#1a232d" }, horzLines: { color: "#1a232d" } },
      rightPriceScale: { borderColor: "#26313e" },
      timeScale: { borderColor: "#26313e", timeVisible: true, secondsVisible: false }
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#35d39a", downColor: "#f07178", borderUpColor: "#35d39a", borderDownColor: "#f07178", wickUpColor: "#35d39a", wickDownColor: "#f07178",
      priceFormat: { type: "price", precision: digits, minMove: 1 / 10 ** digits }
    });
    const ema9 = chart.addSeries(LineSeries, { color: "#22d3ee", lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false });
    const ema21 = chart.addSeries(LineSeries, { color: "#a78bfa", lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false });
    const volumePane = chart.addPane();
    volumePane.setHeight(76);
    const volume = volumePane.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false
    });
    chartRef.current = { chart, series, ema9, ema21, volume, markers: createSeriesMarkers(series, []) };
    lastTime.current = null;
    firstTime.current = null;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) chart.applyOptions({ width: w });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chartRef.current = null;
      chart.remove();
    };
  }, [digits]);

  useEffect(() => {
    const c = chartRef.current;
    if (!c || !candles.length) return;
    if (lastTime.current === null || firstTime.current !== candles[0]!.time) {
      c.series.setData(candles.map(toBar));
      if (lastTime.current === null) c.chart.timeScale().scrollToRealTime();
    } else {
      for (const k of candles) if (k.time >= lastTime.current) c.series.update(toBar(k));
    }
    c.ema9.setData(emaData(candles, 9));
    c.ema21.setData(emaData(candles, 21));
    c.volume.setData(candles.map((bar) => ({
      time: bar.time as UTCTimestamp,
      value: bar.volume,
      color: bar.close >= bar.open ? "rgba(53,211,154,.55)" : "rgba(240,113,120,.55)"
    })));
    firstTime.current = candles[0]!.time;
    lastTime.current = candles.at(-1)!.time;
  }, [candles, digits]);

  useEffect(() => {
    const c = chartRef.current;
    if (!c) return;
    const lines: IPriceLine[] = [];
    const line = (price: number, color: string, style: LineStyle, title: string, width: 1 | 2 = 1) => {
      if (Number.isFinite(price) && price > 0) lines.push(c.series.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title }));
    };
    for (const lv of cycle?.levels ?? []) line(lv.price, lv.side === "high" ? "rgba(240,113,120,.55)" : "rgba(96,165,250,.6)", LineStyle.Dotted, lv.name);
    const s = cycle?.setup;
    if (s) {
      line(s.entry_price, "#e5edf5", LineStyle.Solid, `${s.direction} ENTRY`, 2);
      line(s.stop_loss, "#f07178", LineStyle.Dashed, "SL", 2);
      line(s.take_profit_1, "#35d39a", LineStyle.Dashed, "TP1");
      line(s.take_profit_2, "#35d39a", LineStyle.Dashed, "TP2");
    }
    for (const p of positions) {
      if (s && p.signal_id === s.signal_id) continue;
      line(p.entry_price, "#f0b968", LineStyle.Solid, `${p.direction} OPEN`);
      if (p.stop_loss) line(p.stop_loss, "#f07178", LineStyle.Dashed, p.breakeven ? "SL (BE)" : "SL");
    }
    c.markers.setMarkers(s ? [
      { time: s.sweep_time as UTCTimestamp, position: s.direction === "SHORT" ? "aboveBar" : "belowBar", color: "#f0b968", shape: "circle", text: `SWEEP ${s.level.name}` },
      { time: s.confirm_time as UTCTimestamp, position: s.direction === "SHORT" ? "aboveBar" : "belowBar", color: s.direction === "SHORT" ? "#f07178" : "#35d39a",
        shape: s.direction === "SHORT" ? "arrowDown" : "arrowUp", text: cycle?.outcome.toUpperCase() ?? "" }
    ] : []);
    return () => {
      if (chartRef.current !== c) return;
      for (const l of lines) c.series.removePriceLine(l);
    };
  }, [cycle, positions, candles.length > 0, digits]);

  return <div aria-label="Price chart with EMA 9, EMA 21, and volume" className="h-[380px] w-full" ref={host} />;
}

export function SweepChart() {
  const instrument = useDesk((s) => s.instrument);
  const instruments = useDesk((s) => s.instruments);
  const candles = useDesk((s) => s.candles[s.instrument]);
  const historyLoaded = useDesk((s) => s.candleHistoryLoaded[s.instrument]);
  const cycle = useDesk((s) => s.lastCycle[s.instrument]);
  const allPositions = useDesk((s) => s.positions);
  const digits = useDesk((s) => s.digits[s.instrument] ?? 2);
  const dataSource = useDesk((s) => s.dataSource);
  const quote = useDesk((s) => s.quotes[s.instrument]);
  const connected = useDesk((s) => s.connected);
  const env = useDesk((s) => s.deltaEnv);
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const stale = !connected || !quote || now - quote.updated_at > 15;
  const positions = allPositions.filter((p) => p.instrument === instrument);
  const last = candles?.at(-1);

  useEffect(() => {
    if (historyLoaded) return;
    const load = () => void loadCandles(instrument).catch((error: unknown) =>
      pushToast({ level: "error", title: "Candle history unavailable", message: error instanceof Error ? error.message : String(error) }));
    load();
    const retry = window.setInterval(load, 15_000);
    return () => window.clearInterval(retry);
  }, [instrument, dataSource, historyLoaded]);

  return (
    <section className="panel">
      <header className="panel-head">
        <div className="flex items-center gap-1">
          {instruments.map((i) => (
            <button key={i} type="button" aria-pressed={i === instrument} className={`tab ${i === instrument ? "tab-on" : ""}`} onClick={() => setState({ instrument: i })}>{i}</button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-terminal-muted">
          <span>5M · {dataSource === "delta" ? `Delta India ${env === "testnet" ? "Demo" : "Live"} · ${stale ? "STALE / unavailable" : "Live feed"}` : "Synthetic demo feed"}</span>
          {(quote && dataSource === "delta" || last) && <b className="num text-terminal-text">{(dataSource === "delta" && quote ? quote.mark : last!.close).toFixed(digits)}</b>}
        </div>
      </header>
      {candles?.length ? <Canvas candles={candles} cycle={cycle} positions={positions} digits={digits} key={`${dataSource}:${instrument}`} /> : <div className="grid h-[380px] place-items-center text-sm text-terminal-muted">{dataSource === "delta" ? "Waiting for Delta India candles. No synthetic data substituted." : "Loading synthetic candles…"}</div>}
      <footer className="flex flex-wrap gap-4 border-t border-terminal-border px-4 py-2 text-[11px] text-terminal-muted">
        <span><i className="legend bg-terminal-red/60" /> buy-side liquidity (highs)</span>
        <span><i className="legend bg-terminal-blue/70" /> sell-side liquidity (lows)</span>
        <span><i className="legend bg-terminal-amber" /> sweep wick</span>
        <span className="inline-flex items-center gap-1"><i className="h-[2px] w-3 bg-cyan-400" />EMA 9</span>
        <span className="inline-flex items-center gap-1"><i className="h-[2px] w-3 bg-violet-400" />EMA 21</span>
        <span><i className="legend bg-terminal-green" /> volume</span>
        <span>{cycle?.levels?.length ?? 0} pools mapped</span>
      </footer>
    </section>
  );
}
