import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "../store/useStore";

const STYLE = {
  success: "border-profit/40 shadow-profit",
  info: "border-cyan-neon/40 shadow-glow",
  warning: "border-warn/50",
  error: "border-loss/50 shadow-loss",
} as const;
const DOT = { success: "bg-profit", info: "bg-cyan-neon", warning: "bg-warn", error: "bg-loss" } as const;

/** Sliding toast stack (top-right). Friendly copy only: never raw errors. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const drop = useStore((s) => s.dropToast);
  return (
    <div className="pointer-events-none fixed right-4 top-16 z-[80] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ x: 380, opacity: 0, scale: 0.96 }}
            animate={{ x: 0, opacity: 1, scale: 1 }}
            exit={{ x: 380, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            onClick={() => drop(t.id)}
            data-cursor="Dismiss"
            className={`pointer-events-auto glass-strong border px-4 py-3 ${STYLE[t.level]}`}
          >
            <div className="flex items-start gap-3">
              <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${DOT[t.level]}`} />
              <div className="min-w-0">
                <div className="font-display text-sm font-semibold text-white">{t.title}</div>
                <div className="mt-0.5 text-xs leading-relaxed text-slate-300">{t.message}</div>
              </div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
