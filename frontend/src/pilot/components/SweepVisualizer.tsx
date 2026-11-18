import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { Glass } from "./Glass";
import type { Candle, Setup } from "../lib/types";
import { px } from "../lib/format";

const STEPS = [
  { t: 0, title: "1 · Liquidity pool", body: "Equal highs / a key level form. Breakout traders park buy-stops just above it: that's liquidity." },
  { t: 0.25, title: "2 · The stop hunt", body: "A wick spikes through the level, triggering the resting stop-losses, which burst like particles." },
  { t: 0.5, title: "3 · Displacement", body: "A strong candle snaps back inside the range within 3 candles: the breakout failed and buyers are trapped." },
  { t: 0.75, title: "4 · Trade ladder", body: "Entry on the confirmation close, stop beyond the wick plus a buffer, TP1 at 1:2, TP2 at the next pool." },
];

interface Model {
  pre: Candle[];
  ev: Candle[];
  level: number;
  side: "high" | "low";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  label: string;
  instrument: string;
}

/** A clean textbook bearish sweep used when there is no live setup to replay. */
function textbook(): Model {
  const pre: Candle[] = [];
  let p = 100;
  const highs = [104.6, 104.9, 104.7, 104.95];
  for (let i = 0; i < 16; i++) {
    const o = p;
    const c = i % 4 === 3 ? 104.2 : 100 + Math.sin(i * 0.9) * 2 + i * 0.18;
    const hi = i % 4 === 3 ? highs[(i / 4) | 0]! : Math.max(o, c) + 0.5;
    pre.push({ time: i, open: o, high: Math.min(hi, 104.95), low: Math.min(o, c) - 0.5, close: c, volume: 1 });
    p = c;
  }
  const sweep: Candle = { time: 16, open: p, high: 106.4, low: p - 0.3, close: 104.6, volume: 3 };
  const disp: Candle = { time: 17, open: 104.6, high: 104.8, low: 101.2, close: 101.5, volume: 4 };
  const sl = 106.9;
  const r = sl - 101.5;
  return { pre, ev: [sweep, disp], level: 105.0, side: "high", entry: 101.5, sl, tp1: 101.5 - 2 * r, tp2: 101.5 - 2.8 * r, label: "Textbook example", instrument: "" };
}

function fromLive(setup: Setup, candles: Candle[]): Model | null {
  const j = candles.findIndex((c) => c.time === setup.sweep_time);
  const i = candles.findIndex((c) => c.time === setup.confirm_time);
  if (j < 10 || i < j) return null;
  return {
    pre: candles.slice(Math.max(0, j - 22), j), ev: candles.slice(j, i + 1), level: setup.level.price, side: setup.level.side,
    entry: setup.entry_price, sl: setup.stop_loss, tp1: setup.take_profit_1, tp2: setup.take_profit_2,
    label: `Live · ${setup.instrument} ${setup.level.name}`, instrument: setup.instrument,
  };
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Step-by-step animated playback of a liquidity sweep with scrubber and Play/Pause. */
export function SweepVisualizer({ setup, candles, height = 300 }: { setup?: Setup | null; candles?: Candle[]; height?: number }) {
  const reduce = useReducedMotion();
  const live = useMemo(() => (setup && candles ? fromLive(setup, candles) : null), [setup, candles]);
  const m = live ?? textbook();
  const [t, setT] = useState(reduce ? 1 : 0);
  const [playing, setPlaying] = useState(!reduce);
  const last = useRef(0);
  const key = setup?.signal_id ?? "textbook";

  useEffect(() => {
    setT(reduce ? 1 : 0);
    setPlaying(!reduce);
  }, [key, reduce]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    last.current = performance.now();
    const step = (now: number) => {
      const dt = (now - last.current) / 1000;
      last.current = now;
      setT((v) => {
        const n = v + dt / 9;
        if (n >= 1) {
          setPlaying(false);
          return 1;
        }
        return n;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const W = 640;
  const H = height;
  const all = [...m.pre, ...m.ev];
  // scale to candles + SL + TP1; TP2 is pinned to the edge when it sits far away
  const lo = Math.min(...all.map((c) => c.low), m.tp1, m.sl);
  const hi = Math.max(...all.map((c) => c.high), m.sl, m.tp1);
  const padY = (hi - lo) * 0.1;
  const yRaw = (v: number) => H - 18 - ((v - (lo - padY)) / (hi - lo + padY * 2)) * (H - 36);
  const y = (v: number) => Math.max(10, Math.min(H - 10, yRaw(v)));
  const n = all.length + 4;
  const cw = (W - 120) / n;
  const x = (i: number) => 16 + i * cw + cw / 2;

  const s1 = clamp01(t / 0.25);
  const s2 = clamp01((t - 0.25) / 0.25);
  const s3 = clamp01((t - 0.5) / 0.25);
  const s4 = clamp01((t - 0.75) / 0.25);
  const stepIdx = t < 0.25 ? 0 : t < 0.5 ? 1 : t < 0.75 ? 2 : 3;
  const bear = m.side === "high";
  const lastEv = m.ev[m.ev.length - 1]!;
  const extreme = bear ? Math.max(...m.ev.map((c) => c.high)) : Math.min(...m.ev.map((c) => c.low));
  const extremeIdx = m.ev.findIndex((c) => (bear ? c.high : c.low) === extreme);

  const renderCandle = (c: Candle, i: number, grow = 1, wickOnly = false, wickGrow = 1) => {
    const up = c.close >= c.open;
    const color = up ? "#10b981" : "#f43f5e";
    const bodyTop = y(Math.max(c.open, c.close));
    const bodyBot = y(Math.min(c.open, c.close));
    const openY = y(c.open);
    const curClose = c.open + (c.close - c.open) * grow;
    const gTop = Math.min(openY, y(curClose));
    const gH = Math.max(1, Math.abs(y(curClose) - openY));
    const wickHi = c.open + (c.high - c.open) * wickGrow;
    const wickLo = c.open + (c.low - c.open) * wickGrow;
    return (
      <g key={`${c.time}-${i}`}>
        <line x1={x(i)} x2={x(i)} y1={y(Math.max(wickHi, c.open))} y2={y(Math.min(wickLo, c.open))} stroke={color} strokeWidth="1.4" opacity={0.95} />
        {!wickOnly && <rect x={x(i) - cw * 0.32} y={grow < 1 ? gTop : bodyTop} width={cw * 0.64} height={grow < 1 ? gH : Math.max(1, bodyBot - bodyTop)} rx="1.5" fill={color} opacity={0.9} />}
      </g>
    );
  };

  const preShown = Math.ceil(s1 * m.pre.length);
  const burst = s2 > 0.55;
  const ladder = [
    { k: "TP2", v: m.tp2, c: "#34d399" }, { k: "TP1", v: m.tp1, c: "#10b981" },
    { k: "ENTRY", v: m.entry, c: "#22d3ee" }, { k: "SL", v: m.sl, c: "#f43f5e" },
  ];

  return (
    <Glass className="p-4" title={<span>Liquidity Sweep Visualizer · <span className="text-cyan-300 normal-case tracking-normal">{m.label}</span></span>}
      right={
        <div className="flex items-center gap-2">
          <button data-cursor={playing ? "Pause" : "Play"} onClick={() => { if (t >= 1) setT(0); setPlaying((p) => !p); }} className="btn-ghost px-3 py-1 text-xs">
            {playing ? "❚❚ Pause" : t >= 1 ? "↺ Replay" : "▶ Play"}
          </button>
        </div>
      }>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" style={{ height: H }}>
        <defs>
          <linearGradient id="pool" x1="0" x2="0" y1={bear ? "1" : "0"} y2={bear ? "0" : "1"}>
            <stop offset="0" stopColor="#22d3ee" stopOpacity="0.32" />
            <stop offset="1" stopColor="#22d3ee" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* liquidity pool glow */}
        <motion.rect x={0} width={W - 100} y={bear ? y(m.level) - 34 : y(m.level)} height={34} fill="url(#pool)"
          animate={{ opacity: s2 > 0.6 ? 0.15 : 0.3 + 0.5 * s1 }} />
        <line x1={0} x2={W - 100} y1={y(m.level)} y2={y(m.level)} stroke="#22d3ee" strokeDasharray="5 4" strokeWidth="1.3" opacity={0.4 + 0.6 * s1} />
        <text x={8} y={y(m.level) + (bear ? -40 : 48)} fill="#67e8f9" fontSize="11" fontFamily="JetBrains Mono" opacity={s1}>
          {bear ? "BUY-STOPS RESTING ABOVE" : "SELL-STOPS RESTING BELOW"} · {px(m.level, m.instrument)}
        </text>
        {/* resting stop dots */}
        {Array.from({ length: 14 }).map((_, k) => {
          const bx = 40 + k * ((W - 180) / 14);
          const by = y(m.level) + (bear ? -10 - (k % 3) * 7 : 10 + (k % 3) * 7);
          const ang = (k / 14) * Math.PI * 2;
          return (
            <motion.circle key={k} r={2.4} fill="#a5f3fc" cx={bx} cy={by} initial={{ cx: bx, cy: by, opacity: 0 }}
              animate={burst ? { cx: x(m.pre.length + extremeIdx) + Math.cos(ang) * 70, cy: y(extreme) + Math.sin(ang) * 50, opacity: 0, scale: 1.6 }
                : { cx: bx, cy: by, opacity: s1 * 0.9, scale: 1 }}
              transition={burst ? { duration: 0.9, ease: "easeOut" } : { duration: 0.3 }} />
          );
        })}
        {/* candles */}
        {m.pre.slice(0, preShown).map((c, i) => renderCandle(c, i))}
        {s2 > 0 && m.ev.map((c, k) => {
          const idx = m.pre.length + k;
          const isLast = k === m.ev.length - 1;
          if (!isLast) return renderCandle(c, idx, 1, false, k === extremeIdx ? s2 : 1);
          if (s3 === 0) return renderCandle(c, idx, 0, true, extremeIdx === k ? s2 : 0.2);
          return renderCandle(c, idx, s3, false, 1);
        })}
        {burst && s2 < 1 && (
          <motion.circle cx={x(m.pre.length + extremeIdx)} cy={y(extreme)} r={6} fill="none" stroke="#f472b6" strokeWidth="2"
            initial={{ r: 4, opacity: 1 }} animate={{ r: 40, opacity: 0 }} transition={{ duration: 0.8 }} />
        )}
        {/* trade ladder */}
        {ladder.map((l, k) => {
          const show = clamp01(s4 * 4 - k * 0.6);
          return (
            <g key={l.k} opacity={show}>
              <line x1={x(m.pre.length + m.ev.length - 1)} x2={W - 100 + (1 - show) * 100} y1={y(l.v)} y2={y(l.v)} stroke={l.c} strokeWidth="1.6" strokeDasharray={l.k === "ENTRY" ? "" : "4 3"} />
              <rect x={W - 98 + (1 - show) * 60} y={y(l.v) - 10} width={94} height={20} rx={6} fill={`${l.c}22`} stroke={l.c} />
              <text x={W - 92 + (1 - show) * 60} y={y(l.v) + 4} fill={l.c} fontSize="10.5" fontFamily="JetBrains Mono">{l.k} {px(l.v, m.instrument)}{yRaw(l.v) > H - 10 ? " ↓" : yRaw(l.v) < 10 ? " ↑" : ""}</text>
            </g>
          );
        })}
        {s3 >= 1 && (
          <motion.text initial={{ opacity: 0 }} animate={{ opacity: 1 }} x={x(m.pre.length + m.ev.length - 1) - 30} y={y(lastEv.close) + (bear ? 26 : -18)} fill="#fbbf24" fontSize="11" fontFamily="Space Grotesk" fontWeight="700">
            DISPLACEMENT
          </motion.text>
        )}
      </svg>
      <div className="mt-2 flex items-center gap-3">
        <input aria-label="Scrub sweep playback" type="range" min={0} max={1000} value={Math.round(t * 1000)} data-cursor="Scrub"
          onChange={(e) => { setPlaying(false); setT(Number(e.target.value) / 1000); }} className="w-full accent-cyan-400" />
        <span className="num w-10 text-right text-xs text-slate-400">{Math.round(t * 100)}%</span>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2">
        {STEPS.map((s, i) => (
          <button key={s.title} onClick={() => { setPlaying(false); setT(s.t + 0.249); }}
            className={`rounded-lg border px-2 py-1.5 text-left text-[11px] transition-colors ${i === stepIdx ? "border-cyan-neon/60 bg-cyan-500/10 text-cyan-100" : "border-white/[0.06] text-slate-400"}`}>
            {s.title}
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.p key={stepIdx} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-2 text-[12.5px] text-slate-300">
          {STEPS[stepIdx]!.body}
        </motion.p>
      </AnimatePresence>
    </Glass>
  );
}
