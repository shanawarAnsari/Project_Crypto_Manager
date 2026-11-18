import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "../store/useStore";
import { Glass } from "./Glass";
import { ConfidenceRing } from "./Metrics";
import { px } from "../lib/format";
import type { CycleSummary } from "../lib/types";

function items(c: CycleSummary, mult: number, rrMin: number) {
  const s = c.setup!;
  const chk = (n: string) => c.checks.find((x) => x.name === n);
  const unit = "%";
  const approved = c.outcome === "taken" || (c.checks.length > 0 && c.checks.every((x) => x.passed));
  return [
    { label: "Level swept", ok: true, detail: `${s.level.name} @ ${px(s.level.price, s.instrument)}` },
    { label: "Depth in range", ok: true, detail: `${s.extension_depth}${unit} beyond the level` },
    { label: "Displacement strong", ok: s.displacement_ratio >= mult, detail: `${s.displacement_ratio}× avg body${s.volume_spike ? " + volume spike" : ""}` },
    { label: "Session OK", ok: chk("Session")?.passed ?? null, detail: chk("Session")?.detail ?? s.session },
    { label: `RR ≥ 1:${rrMin}`, ok: chk("Risk:Reward")?.passed ?? null, detail: chk("Risk:Reward")?.detail ?? `1:${s.risk_reward_ratio}` },
    { label: "Guardian approved", ok: c.checks.length ? approved : null,
      detail: c.checks.length ? (approved ? "All AEGIS checks passed" : c.checks.filter((x) => !x.passed).map((x) => x.name).join(", ")) : c.outcome === "skipped" ? "Analyst said NO_TRADE" : "Pending" },
  ];
}

/** "Why this trade?": animated checklist, the Analyst's reasoning and a confidence ring. */
export function WhyThisTrade({ compact = false }: { compact?: boolean }) {
  const instrument = useStore((s) => s.instrument);
  const dataSource = useStore((s) => s.dataSource);
  const cycle = useStore((s) => s.lastCycle[s.instrument]);
  const params = useStore((s) => s.params);
  const rules = useStore((s) => s.rules);
  const model = useStore((s) => s.model);
  const analystMode = useStore((s) => s.analystMode);
  const beginner = useStore((s) => s.beginner);

  if (!cycle?.setup) {
    return (
      <Glass className="p-4" title={`Why this trade? · ${instrument}`}>
        <div className="mt-3 flex items-center gap-3 text-sm text-slate-400">
          <span className="relative flex h-3 w-3"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-60" /><span className="relative inline-flex h-3 w-3 rounded-full bg-cyan-500" /></span>
          {dataSource === "delta"
            ? "The strategy is monitoring live Delta market data. A trade explanation appears here when a qualifying setup is identified."
            : <>The Hunter is scanning for a liquidity sweep on every closed 5M candle. On the demo feed, press <b className="text-cyan-200">Run Demo Scenario</b> to see one now.</>}
        </div>
        <div className="mt-3 space-y-2">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-4 rounded" />)}</div>
      </Glass>
    );
  }
  const s = cycle.setup;
  const d = cycle.decision;
  const list = items(cycle, params?.displacement_mult ?? 1.2, rules?.min_rr ?? 2);
  const outcomeStyle = { taken: "text-profit border-profit/50 bg-profit/10", vetoed: "text-rose-300 border-loss/50 bg-loss/10",
    skipped: "text-amber-200 border-warn/50 bg-warn/10", error: "text-rose-300 border-loss/50 bg-loss/10", none: "text-slate-300 border-white/10" }[cycle.outcome];
  return (
    <Glass className="p-4" tilt cursor="Inspect" title={`Why this trade? · ${s.instrument}`}
      right={<span className={`chip ${outcomeStyle}`}>{cycle.outcome.toUpperCase()}</span>}>
      <AnimatePresence mode="wait">
        <motion.div key={s.signal_id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-3">
          <div className="flex items-start gap-4">
            <ul className="min-w-0 flex-1 space-y-1.5">
              {list.map((it, i) => (
                <motion.li key={it.label} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.12 * i, type: "spring", stiffness: 300, damping: 24 }}
                  className="flex items-start gap-2 text-[13px]">
                  <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.12 * i + 0.1, type: "spring", stiffness: 500, damping: 15 }}
                    className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold ${
                      it.ok === null ? "bg-slate-600/40 text-slate-300" : it.ok ? "bg-profit/25 text-emerald-300" : "bg-loss/25 text-rose-300"}`}>
                    {it.ok === null ? "…" : it.ok ? "✓" : "✕"}
                  </motion.span>
                  <span className="min-w-0">
                    <span className="font-medium text-slate-100">{it.label}</span>
                    {!compact && <span className="block truncate text-[11px] text-slate-400">{it.detail}</span>}
                  </span>
                </motion.li>
              ))}
            </ul>
            {d && <ConfidenceRing score={d.confidence_score} />}
          </div>
          {d && (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.8 }}
              className="mt-3 rounded-xl border border-violet-neon/25 bg-violet-500/[0.07] p-3">
              <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-widest text-violet-300">
                <span>◆ Analyst · {analystMode === "llm" ? (model || "LLM") : "rule-based"}</span>
              </div>
              <p className="text-[12.5px] leading-relaxed text-slate-200">{d.reasoning}</p>
              {!beginner && (
                <div className="mt-2 grid grid-cols-4 gap-1.5 text-center">
                  {[["Entry", d.trade_plan.entry_price, "text-cyan-200"], ["SL", d.trade_plan.stop_loss, "text-rose-300"],
                    ["TP1", d.trade_plan.take_profit_1, "text-emerald-300"], ["TP2", d.trade_plan.take_profit_2, "text-emerald-200"]].map(([k, v, c]) => (
                    <div key={k as string} className="rounded-lg bg-black/25 px-1 py-1">
                      <div className="text-[9px] uppercase text-slate-500">{k}</div>
                      <div className={`num text-[11px] ${c}`}>{px(v as number, s.instrument)}</div>
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </motion.div>
      </AnimatePresence>
    </Glass>
  );
}
