import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries, createChart, createSeriesMarkers, LineStyle,
  type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp
} from "lightweight-charts";
import { useStore } from "../store/useStore";
import { loadCandles } from "../lib/live";
import { Glass } from "../components/Glass";
import { SweepVisualizer } from "../components/SweepVisualizer";
import type { Candle } from "../lib/types";
import { px } from "../lib/format";

const toBar = (c: Candle) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });

export function InstrumentTabs() {
  const instrument = useStore((s) => s.instrument);
  const instruments = useStore((s) => s.instruments);
  const quotes = useStore((s) => s.quotes);
  const set = useStore((s) => s.set);
  const last = useStore((s) => s.candles);
  return (
    <div className="flex gap-1.5 rounded-xl border border-white/[0.07] bg-black/20 p-1">
      {instruments.map((i) => {
        const price = quotes[i]?.mark ?? last[i]?.at(-1)?.close;
        return (
          <button key={i} onClick={() => set({ instrument: i })} data-cursor="Switch"
            className={`rounded-lg px-3 py-1.5 text-left text-xs transition-colors ${instrument === i ? "bg-cyan-500/15 text-white shadow-glow" : "text-slate-400 hover:text-slate-200"}`}>
            <div className="font-display font-semibold">{i}</div>
            <div className="num text-[10.5px] opacity-80">{price != null ? px(price, i) : "…"}</div>
          </button>
        );
      })}
    </div>
  );
}

function LiveChart({ digits }: { digits: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const timers = useRef<number[]>([]);
  const instrument = useStore((s) => s.instrument);
  const candles = useStore((s) => s.candles[s.instrument]);
  const cycle = useStore((s) => s.lastCycle[s.instrument]);
  const allPositions = useStore((s) => s.positions);
  const fitted = useRef<string>("");
  const firstTime = useRef<number | null>(null);
  const lastTime = useRef<number | null>(null);

  useEffect(() => {
    const host = el.current;
    if (!host) return;
    const c = createChart(host, {
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      layout: { background: { color: "transparent" }, textColor: "#94a3b8", fontFamily: "JetBrains Mono", fontSize: 11 },
      grid: { vertLines: { color: "rgba(255,255,255,.035)" }, horzLines: { color: "rgba(255,255,255,.035)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,.08)" },
      timeScale: { borderColor: "rgba(255,255,255,.08)", timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "rgba(34,211,238,.4)" }, horzLine: { color: "rgba(34,211,238,.4)" } }
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: "#10b981", downColor: "#f43f5e", wickUpColor: "#10b981", wickDownColor: "#f43f5e", borderVisible: false,
      priceFormat: { type: "price", precision: digits, minMove: 1 / 10 ** digits }
    });
    series.current = s;
    markers.current = createSeriesMarkers(s, []);
    chart.current = c;
    const resize = new ResizeObserver((entries) => {
      const { width, height } = entries[0]?.contentRect ?? { width: 0, height: 0 };
      if (width > 0 && height > 0) c.applyOptions({ width, height });
    });
    resize.observe(host);
    fitted.current = "";
    firstTime.current = null;
    lastTime.current = null;
    return () => {
      resize.disconnect();
      timers.current.forEach(clearTimeout);
      c.remove();
      chart.current = null;
      series.current = null;
      markers.current = null;
      lines.current = [];
    };
  }, [digits]);

  useEffect(() => {
    const s = series.current;
    if (!s || !candles?.length) return;
    // Full reload only when history changes; streaming ticks update the last bar in place.
    if (lastTime.current === null || firstTime.current !== candles[0]!.time || fitted.current !== instrument) {
      s.setData(candles.map(toBar));
    } else {
      for (const k of candles) if (k.time >= lastTime.current) s.update(toBar(k));
    }
    firstTime.current = candles[0]!.time;
    lastTime.current = candles.at(-1)!.time;
    if (fitted.current !== instrument) {
      chart.current?.timeScale().setVisibleLogicalRange({ from: candles.length - 140, to: candles.length + 8 });
      fitted.current = instrument;
    }
  }, [candles, instrument]);

  // levels + live setup ladder; the ladder slides in step by step like the visualizer
  const hasCandles = !!candles?.length;
  useEffect(() => {
    const s = series.current;
    if (!s || !hasCandles) return;
    lines.current.forEach((l) => s.removePriceLine(l));
    lines.current = [];
    timers.current.forEach(clearTimeout);
    timers.current = [];
    (cycle?.levels ?? []).slice(-14).forEach((lv) => {
      lines.current.push(s.createPriceLine({ price: lv.price, color: lv.side === "high" ? "rgba(34,211,238,.55)" : "rgba(167,139,250,.55)",
        lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: lv.name }));
    });
    const st = cycle?.setup;
    for (const p of allPositions) {
      if (p.instrument !== instrument || (st && p.signal_id === st.signal_id)) continue;
      lines.current.push(s.createPriceLine({ price: p.entry_price, color: "#f59e0b", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: `${p.direction} OPEN` }));
      if (p.stop_loss) lines.current.push(s.createPriceLine({ price: p.stop_loss, color: "#f43f5e", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: p.breakeven ? "SL (BE)" : "SL" }));
    }
    const m: SeriesMarker<Time>[] = [];
    if (st && cycle) {
      m.push({ time: st.sweep_time as UTCTimestamp, position: st.direction === "SHORT" ? "aboveBar" : "belowBar", color: "#f472b6", shape: "circle", text: `SWEEP ${st.level.name}` });
      m.push({ time: st.confirm_time as UTCTimestamp, position: st.direction === "SHORT" ? "aboveBar" : "belowBar", color: "#fbbf24",
        shape: st.direction === "SHORT" ? "arrowDown" : "arrowUp", text: `${st.direction} ${cycle.outcome === "taken" ? "✓" : cycle.outcome}` });
      const ladder = [
        { price: st.entry_price, color: "#22d3ee", title: "ENTRY", style: LineStyle.Solid },
        { price: st.stop_loss, color: "#f43f5e", title: "SL", style: LineStyle.Dashed },
        { price: st.take_profit_1, color: "#10b981", title: "TP1", style: LineStyle.Dashed },
        { price: st.take_profit_2, color: "#34d399", title: "TP2", style: LineStyle.Dashed }
      ];
      ladder.forEach((l, i) => {
        timers.current.push(window.setTimeout(() => {
          if (!series.current) return;
          lines.current.push(series.current.createPriceLine({ price: l.price, color: l.color, lineWidth: 2, lineStyle: l.style, axisLabelVisible: true, title: l.title }));
        }, 350 * (i + 1)));
      });
    }
    markers.current?.setMarkers(m);
  }, [cycle, allPositions, instrument, hasCandles, digits]);

  return <div ref={el} className="h-full w-full" data-testid="live-chart" />;
}

export function ChartView() {
  const instrument = useStore((s) => s.instrument);
  const cycle = useStore((s) => s.lastCycle[s.instrument]);
  const candles = useStore((s) => s.candles[s.instrument]);
  const dataSource = useStore((s) => s.dataSource);
  const env = useStore((s) => s.deltaEnv);
  const quote = useStore((s) => s.quotes[s.instrument]);
  const wsConnected = useStore((s) => s.wsConnected);
  const digits = useStore((s) => s.digits[s.instrument] ?? 2);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(t);
  }, []);
  // Retry history until it arrives (e.g. Delta India briefly unreachable at boot).
  useEffect(() => {
    if (candles?.length) return;
    const t = window.setInterval(() => void loadCandles(instrument).catch(() => undefined), 15_000);
    return () => window.clearInterval(t);
  }, [instrument, candles?.length]);
  const stale = !wsConnected || !quote || now - quote.updated_at > 15;
  const feed = dataSource === "delta"
    ? `Delta India ${env === "testnet" ? "Demo" : "Live"} · ${stale ? "STALE / unavailable" : "live feed"}`
    : "synthetic replay with planted sweeps";
  return (
    <div className="flex h-full flex-col gap-3">
      <Glass className="flex min-h-[360px] flex-[1.15] flex-col p-3" glow="none">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <InstrumentTabs />
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className={`h-1.5 w-1.5 rounded-full ${dataSource === "delta" ? (stale ? "bg-warn" : "bg-profit animate-pulse") : "bg-cyan-neon"}`} />
            5M · {feed} · dotted lines are mapped liquidity pools
          </div>
          {dataSource === "delta" && quote && <div className="num ml-auto text-sm text-white">Mark {px(quote.mark, instrument)}</div>}
        </div>
        <div className="relative min-h-0 flex-1">
          <LiveChart key={`${dataSource}:${instrument}`} digits={digits} />
          {!candles?.length && (
            <div className="absolute inset-0 grid place-items-center text-sm text-slate-400">
              {dataSource === "delta" ? "Waiting for Delta India candles. No synthetic data substituted." : "Loading synthetic candles…"}
            </div>
          )}
        </div>
      </Glass>
      <SweepVisualizer setup={cycle?.setup} candles={candles} height={270} />
    </div>
  );
}
