import { motion, useReducedMotion } from "framer-motion";
import { useRef, useState } from "react";
import { post } from "../lib/api";
import { useStore } from "../store/useStore";

const HOLD_MS = 1400;

/** Big KILL SWITCH with a hold-to-confirm progress ring. Holding again releases it. */
export function KillSwitch() {
  const engaged = useStore((s) => s.kpis?.kill_switch ?? false);
  const [progress, setProgress] = useState(0);
  const [closeAll, setCloseAll] = useState(true);
  const raf = useRef(0);
  const start = useRef(0);
  const reduce = useReducedMotion();

  const begin = () => {
    start.current = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - start.current) / HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        cancel();
        void post("/api/kill", { engaged: !engaged, close_all: !engaged && closeAll });
        return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  const cancel = () => {
    cancelAnimationFrame(raf.current);
    setProgress(0);
  };

  const R = 44;
  const C = 2 * Math.PI * R;
  return (
    <div className="flex items-center gap-4" data-tour="kill">
      <motion.button
        data-cursor={engaged ? "Hold: release" : "Hold to kill"}
        onPointerDown={begin}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !e.repeat && begin()}
        onKeyUp={cancel}
        aria-label={engaged ? "Hold to release kill switch" : "Hold to engage kill switch"}
        animate={engaged && !reduce ? { boxShadow: ["0 0 0px #f43f5e", "0 0 34px #f43f5e", "0 0 0px #f43f5e"] } : {}}
        transition={{ duration: 1.6, repeat: Infinity }}
        className="relative h-[104px] w-[104px] flex-none select-none rounded-full"
      >
        <svg width="104" height="104" className="absolute inset-0 -rotate-90">
          <circle cx="52" cy="52" r={R} stroke="rgba(244,63,94,.18)" strokeWidth="6" fill="none" />
          <circle cx="52" cy="52" r={R} stroke="#f43f5e" strokeWidth="6" fill="none" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - progress)} style={{ filter: "drop-shadow(0 0 6px #f43f5e)" }} />
        </svg>
        <div className={`absolute inset-[12px] flex flex-col items-center justify-center rounded-full border-2 ${
          engaged ? "border-rose-300 bg-loss text-white" : "border-loss/60 bg-gradient-to-b from-rose-600/40 to-rose-900/40 text-rose-100"
        } transition-colors`}>
          <span className="font-display text-[13px] font-bold tracking-widest">{engaged ? "KILLED" : "KILL"}</span>
          <span className="text-[8.5px] uppercase tracking-wider opacity-80">{engaged ? "hold to release" : "hold"}</span>
        </div>
      </motion.button>
      <div className="min-w-0 text-xs text-slate-400">
        <div className={`font-semibold ${engaged ? "text-rose-300" : "text-slate-200"}`}>{engaged ? "All new orders blocked" : "Emergency stop"}</div>
        <p className="mt-1 leading-snug">Stops new orders immediately{closeAll ? " and closes every paper position plus every desk instrument position on your Delta India account (reduce-only market orders)" : ""}.</p>
        {!engaged && (
          <label className="mt-2 flex items-center gap-2">
            <input type="checkbox" checked={closeAll} onChange={(e) => setCloseAll(e.target.checked)} className="accent-rose-500" />
            Close all positions too
          </label>
        )}
      </div>
    </div>
  );
}
