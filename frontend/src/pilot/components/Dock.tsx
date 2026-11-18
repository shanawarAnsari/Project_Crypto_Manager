import { motion, useMotionValue, useSpring, useTransform, type MotionValue } from "framer-motion";
import { useRef } from "react";
import { useStore } from "../store/useStore";
import type { ViewId } from "../lib/types";

export const DOCK_ITEMS: { id: ViewId; label: string; icon: string }[] = [
  { id: "overview", label: "Overview", icon: "▦" },
  { id: "chart", label: "Chart", icon: "📈" },
  { id: "signals", label: "Signals", icon: "⚡" },
  { id: "backtest", label: "Backtest", icon: "🧪" },
  { id: "journal", label: "Journal", icon: "📓" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

function DockIcon({ mouseX, item, active, onClick }: { mouseX: MotionValue<number>; item: (typeof DOCK_ITEMS)[number]; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const dist = useTransform(mouseX, (v) => {
    const r = ref.current?.getBoundingClientRect();
    return r ? v - (r.left + r.width / 2) : 9999;
  });
  const size = useSpring(useTransform(dist, [-140, 0, 140], [44, 70, 44]), { stiffness: 260, damping: 18, mass: 0.2 });
  return (
    <motion.button
      ref={ref}
      style={{ width: size, height: size }}
      onClick={onClick}
      data-cursor={item.label}
      aria-label={item.label}
      className={`group relative flex items-center justify-center rounded-2xl border text-xl ${
        active ? "border-cyan-neon/60 bg-cyan-500/15 shadow-glow" : "border-white/10 bg-white/[0.05] hover:bg-white/[0.09]"
      }`}
    >
      <span className="pointer-events-none">{item.icon}</span>
      <span className="pointer-events-none absolute -top-8 whitespace-nowrap rounded-md bg-black/80 px-2 py-0.5 text-[10px] text-slate-200 opacity-0 transition-opacity group-hover:opacity-100">
        {item.label}
      </span>
      {active && <motion.span layoutId="dock-dot" className="absolute -bottom-1.5 h-1 w-1 rounded-full bg-cyan-neon" />}
    </motion.button>
  );
}

/** macOS-style magnifying command dock. */
export function Dock() {
  const mouseX = useMotionValue(Infinity);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-9 z-50 flex justify-center" data-tour="dock">
      <motion.nav
        onMouseMove={(e) => mouseX.set(e.clientX)}
        onMouseLeave={() => mouseX.set(Infinity)}
        className="pointer-events-auto glass-strong flex h-[66px] items-end gap-2.5 rounded-3xl px-3 pb-2.5"
      >
        {DOCK_ITEMS.map((it) => (
          <DockIcon
            key={it.id}
            mouseX={mouseX}
            item={it}
            active={view === it.id}
            onClick={() => setView(it.id)}
          />
        ))}
      </motion.nav>
    </div>
  );
}
