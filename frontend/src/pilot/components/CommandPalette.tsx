import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store/useStore";
import { post } from "../lib/api";

interface Cmd { id: string; label: string; hint: string; run: () => void }

/** Ctrl/Cmd+K command palette. */
export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const set = useStore((s) => s.set);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  const cmds: Cmd[] = useMemo(() => {
    const st = useStore.getState;
    const go = (v: Parameters<ReturnType<typeof st>["setView"]>[0]) => () => st().setView(v);
    return [
      { id: "o", label: "Go to Overview", hint: "View", run: go("overview") },
      { id: "ch", label: "Go to Chart", hint: "View", run: go("chart") },
      { id: "s", label: "Go to Signals", hint: "View", run: go("signals") },
      { id: "b", label: "Go to Backtest Lab", hint: "View", run: go("backtest") },
      { id: "j", label: "Go to Journal", hint: "View", run: go("journal") },
      { id: "st", label: "Go to Settings & Guardrails", hint: "View", run: go("settings") },
      ...(st().dataSource === "demo" ? [
        { id: "demo", label: "Run Demo Scenario", hint: "Action", run: () => void post("/api/demo/scenario", { instrument: st().instrument }).catch(() => undefined) },
      ] : []),
      ...st().instruments.map((i) => ({ id: `inst-${i}`, label: `Switch instrument: ${i}`, hint: "Market", run: () => st().set({ instrument: i }) })),
      { id: "pause", label: "Pause / resume agents", hint: "Action", run: () => void post("/api/pause", { paused: !st().paused }).catch(() => undefined) },
      { id: "recheck", label: "Re-check Delta India connection", hint: "Delta", run: () => void post("/api/delta/reconnect", {}).catch(() => undefined) },
      { id: "mode", label: "Toggle Beginner / Pro", hint: "Display", run: () => st().toggle("beginner") },
      { id: "snd", label: "Toggle sound", hint: "Display", run: () => st().toggle("sound") },
      { id: "2d", label: "Toggle 2D (low-power) mode", hint: "Display", run: () => st().toggle("force2D") },
      { id: "tour", label: "Replay onboarding tour", hint: "Help", run: () => st().set({ tourOpen: true }) },
      { id: "review", label: "Generate AI daily review", hint: "Journal", run: () => void post("/api/review", {}).catch(() => undefined) },
    ];
  }, [open]);

  const list = cmds.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        set({ paletteOpen: !useStore.getState().paletteOpen });
      } else if (e.key === "Escape") set({ paletteOpen: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);

  useEffect(() => {
    setQ("");
    setIdx(0);
  }, [open]);

  const exec = (c?: Cmd) => {
    if (!c) return;
    c.run();
    set({ paletteOpen: false });
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[95] flex items-start justify-center bg-black/50 pt-[14vh] backdrop-blur-sm"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => set({ paletteOpen: false })}>
          <motion.div onClick={(e) => e.stopPropagation()} initial={{ y: -20, scale: 0.97 }} animate={{ y: 0, scale: 1 }} exit={{ y: -10, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }} className="glass-strong w-[560px] max-w-[calc(100vw-32px)] overflow-hidden">
            <input
              autoFocus
              value={q}
              onChange={(e) => { setQ(e.target.value); setIdx(0); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setIdx((i) => Math.min(list.length - 1, i + 1));
                if (e.key === "ArrowUp") setIdx((i) => Math.max(0, i - 1));
                if (e.key === "Enter") exec(list[idx]);
              }}
              placeholder="Type a command…"
              className="w-full border-b border-white/10 bg-transparent px-5 py-4 font-display text-base text-white placeholder:text-slate-500 focus:outline-none"
            />
            <div className="max-h-[50vh] overflow-y-auto p-2">
              {list.map((c, i) => (
                <button key={c.id} onMouseEnter={() => setIdx(i)} onClick={() => exec(c)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm ${i === idx ? "bg-cyan-500/15 text-white" : "text-slate-300"}`}>
                  {c.label}
                  <span className="text-[10px] uppercase tracking-widest text-slate-500">{c.hint}</span>
                </button>
              ))}
              {!list.length && <div className="px-3 py-6 text-center text-sm text-slate-500">No matching command</div>}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
