import { animate, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";

/** Spring count-up number. */
export function CountUp({ value, format, className = "" }: { value: number; format: (v: number) => string; className?: string }) {
  const [shown, setShown] = useState(value);
  const prev = useRef(value);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (reduce) {
      setShown(value);
      return;
    }
    const ctl = animate(prev.current, value, { duration: 0.8, ease: [0.22, 1, 0.36, 1], onUpdate: setShown });
    prev.current = value;
    return () => ctl.stop();
  }, [value, reduce]);
  return <span className={`num ${className}`}>{format(shown)}</span>;
}

/** Self-drawing equity curve (SVG path animated with pathLength). */
export function EquityCurve({ points, height = 90, color = "#22d3ee", markers }: {
  points: { time: number; equity: number }[]; height?: number; color?: string;
  markers?: { time: number; type: string; pnl?: number }[];
}) {
  const w = 600;
  const { d, area, xs, ys, minT, maxT } = useMemo(() => {
    if (points.length < 2) return { d: "", area: "", xs: () => 0, ys: () => 0, minT: 0, maxT: 1 };
    const minE = Math.min(...points.map((p) => p.equity));
    const maxE = Math.max(...points.map((p) => p.equity));
    const minT = points[0]!.time;
    const maxT = points[points.length - 1]!.time;
    const span = maxE - minE || 1;
    const xs = (t: number) => ((t - minT) / (maxT - minT || 1)) * w;
    const ys = (e: number) => height - 6 - ((e - minE) / span) * (height - 12);
    const d = points.map((p, i) => `${i ? "L" : "M"}${xs(p.time).toFixed(1)},${ys(p.equity).toFixed(1)}`).join(" ");
    return { d, area: `${d} L${w},${height} L0,${height} Z`, xs, ys, minT, maxT };
  }, [points, height]);
  if (!d) return <div className="skeleton rounded-lg" style={{ height }} />;
  const up = points[points.length - 1]!.equity >= points[0]!.equity;
  const c = color === "auto" ? (up ? "#10b981" : "#f43f5e") : color;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      <defs>
        <linearGradient id={`eq-${c}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={c} stopOpacity="0.35" />
          <stop offset="1" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#eq-${c})`} />
      <motion.path key={points.length > 50 ? Math.floor(points.length / 400) : points.length} d={d} fill="none" stroke={c} strokeWidth="2"
        vectorEffect="non-scaling-stroke" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4, ease: "easeInOut" }}
        style={{ filter: `drop-shadow(0 0 4px ${c})` }} />
      {markers?.filter((m) => m.time >= minT && m.time <= maxT).map((m, i) => {
        const near = points.reduce((a, p) => (Math.abs(p.time - m.time) < Math.abs(a.time - m.time) ? p : a), points[0]!);
        return (
          <motion.circle key={`${m.time}-${i}`} cx={xs(m.time)} cy={ys(near.equity)} r={m.type === "entry" ? 3 : 3.5}
            fill={m.type === "entry" ? "#22d3ee" : (m.pnl ?? 0) >= 0 ? "#10b981" : "#f43f5e"}
            initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.2 + (i / (markers.length || 1)) * 1.2, type: "spring", stiffness: 400, damping: 14 }} />
        );
      })}
    </svg>
  );
}

/** Drawdown gauge with a spring needle (0 → kill limit). */
export function DrawdownGauge({ value, limit }: { value: number; limit: number }) {
  const frac = Math.min(1, value / (limit || 1));
  const angle = -90 + frac * 180;
  const color = frac < 0.5 ? "#10b981" : frac < 0.8 ? "#f59e0b" : "#f43f5e";
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 120 70" className="w-full max-w-[170px]">
        <defs>
          <linearGradient id="dd-g" x1="0" x2="1">
            <stop offset="0" stopColor="#10b981" />
            <stop offset="0.6" stopColor="#f59e0b" />
            <stop offset="1" stopColor="#f43f5e" />
          </linearGradient>
        </defs>
        <path d="M10 62 A50 50 0 0 1 110 62" fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="9" strokeLinecap="round" />
        <path d="M10 62 A50 50 0 0 1 110 62" fill="none" stroke="url(#dd-g)" strokeWidth="9" strokeLinecap="round" opacity="0.85" />
        <motion.g animate={{ rotate: angle }} transition={{ type: "spring", stiffness: 90, damping: 11 }} style={{ originX: "60px", originY: "62px" }}>
          <line x1="60" y1="62" x2="60" y2="20" stroke={color} strokeWidth="2.5" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
        </motion.g>
        <circle cx="60" cy="62" r="5" fill="#0a0c1c" stroke={color} strokeWidth="2" />
      </svg>
      <div className="-mt-1 num text-xs text-slate-300">{value.toFixed(2)}% <span className="text-slate-500">/ {limit}% kill</span></div>
    </div>
  );
}

/** Animated confidence ring (1-10). */
export function ConfidenceRing({ score, size = 76 }: { score: number; size?: number }) {
  const r = size / 2 - 7;
  const c = 2 * Math.PI * r;
  const color = score >= 8 ? "#10b981" : score >= 7 ? "#22d3ee" : score >= 5 ? "#f59e0b" : "#f43f5e";
  return (
    <div className="relative flex-none" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,.08)" strokeWidth="6" fill="none" />
        <motion.circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="6" fill="none" strokeLinecap="round"
          strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - score / 10) }}
          transition={{ type: "spring", stiffness: 60, damping: 14 }} style={{ filter: `drop-shadow(0 0 5px ${color})` }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="num text-xl font-bold text-white">{score}</span>
        <span className="text-[9px] uppercase tracking-wider text-slate-400">/ 10</span>
      </div>
    </div>
  );
}
