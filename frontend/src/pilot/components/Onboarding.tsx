import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { safeStorage } from "../config/storage";

const STEPS = [
  { sel: "[data-tour=overview]", title: "Live strategy overview", body: "Review the latest status from each stage of the strategy pipeline and see recent decisions in one place." },
  { sel: "[data-tour=kpis]", title: "Your account at a glance", body: "Equity, today's P/L, win rate and open risk update live. The top card is your real Delta India account; the paper simulation is labelled separately." },
  { sel: "[data-tour=kill]", title: "AEGIS shield & kill switch", body: "The Risk Guardian vetoes anything unsafe. Hold the kill switch to stop all new orders instantly." },
  { sel: "[data-tour=dock]", title: "Desk navigation", body: "Switch between Overview, Chart, Signals, Backtest, Journal and Settings. Ctrl/Cmd+K opens the command palette." },
];

/** 5-step spotlight tour shown on first launch. */
export function Onboarding() {
  const open = useStore((s) => s.tourOpen);
  const set = useStore((s) => s.set);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = document.querySelector(STEPS[i]!.sel);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    const t = window.setInterval(measure, 400);
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("resize", measure);
    };
  }, [open, i]);

  const finish = () => {
    safeStorage()?.setItem("qp_tour_done", "1");
    set({ tourOpen: false });
    setI(0);
  };

  if (!open) return null;
  const pad = 8;
  const r = rect ?? new DOMRect(innerWidth / 2 - 100, innerHeight / 2 - 50, 200, 100);
  const below = r.bottom + 190 < innerHeight;
  const cardTop = below ? r.bottom + 16 : Math.max(16, r.top - 186);
  const cardLeft = Math.min(Math.max(16, r.left + r.width / 2 - 170), innerWidth - 356);
  return (
    <div className="fixed inset-0 z-[97]">
      <svg className="absolute inset-0 h-full w-full" onClick={finish}>
        <defs>
          <mask id="qp-tour">
            <rect width="100%" height="100%" fill="white" />
            <motion.rect initial={false} x={r.left - pad} y={r.top - pad} width={r.width + pad * 2} height={r.height + pad * 2} animate={{ x: r.left - pad, y: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 }}
              transition={{ type: "spring", stiffness: 200, damping: 26 }} rx="16" fill="black" />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(2,3,10,.72)" mask="url(#qp-tour)" />
        <motion.rect initial={false} x={r.left - pad} y={r.top - pad} width={r.width + pad * 2} height={r.height + pad * 2} animate={{ x: r.left - pad, y: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 }}
          transition={{ type: "spring", stiffness: 200, damping: 26 }} rx="16" fill="none" stroke="#22d3ee" strokeWidth="1.5"
          style={{ filter: "drop-shadow(0 0 10px #22d3ee)" }} />
      </svg>
      <AnimatePresence mode="wait">
        <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
          style={{ top: cardTop, left: cardLeft }} className="glass-strong absolute w-[340px] p-5">
          <div className="label">Step {i + 1} / {STEPS.length}</div>
          <div className="mt-1 font-display text-lg font-semibold text-white">{STEPS[i]!.title}</div>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{STEPS[i]!.body}</p>
          <div className="mt-4 flex items-center justify-between">
            <button onClick={finish} className="text-xs text-slate-400 hover:text-slate-200">Skip tour</button>
            <div className="flex gap-2">
              {i > 0 && <button onClick={() => setI(i - 1)} className="btn-ghost px-3 py-1.5 text-xs">Back</button>}
              <button onClick={() => (i === STEPS.length - 1 ? finish() : setI(i + 1))} className="btn-primary px-3 py-1.5 text-xs">
                {i === STEPS.length - 1 ? "Open desk" : "Next"}
              </button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
