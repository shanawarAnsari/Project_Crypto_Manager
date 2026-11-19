import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useStore } from "../store/useStore";
import { Glass } from "../components/Glass";
import { DeltaExecutionLog, DeltaFills, DeltaStatusCard } from "../components/DeltaPanels";
import { api } from "../lib/api";
import { dateTime, px, usd } from "../lib/format";
import type { ExchangePosition, JournalRow } from "../lib/types";

function PositionList({ title, positions, empty }: { title: string; positions: ExchangePosition[]; empty: string }) {
  return (
    <Glass className="p-4" title={title} right={<span className="num text-xs text-slate-400">{positions.length}</span>}>
      {!positions.length && <p className="py-6 text-center text-sm text-slate-500">{empty}</p>}
      <div className="mt-2 space-y-2">
        <AnimatePresence initial={false}>
          {positions.map((p) => {
            const pnl = p.unrealized_pnl;
            return (
              <motion.div key={`${p.venue}-${p.id}`} layout initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 80 }}
                transition={{ type: "spring", stiffness: 300, damping: 24 }}
                className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-black/25 p-3">
                <span className={`chip ${p.direction === "LONG" ? "border-profit/50 text-emerald-300" : "border-loss/50 text-rose-300"}`}>{p.direction}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-display text-sm font-semibold text-white">
                    {p.instrument} <span className="num text-xs text-slate-400">{p.volume} contracts</span>
                  </div>
                  <div className="num mt-0.5 text-[11px] text-slate-400">
                    Entry {px(p.entry_price, p.instrument)} · Mark {px(p.mark_price, p.instrument)}
                  </div>
                </div>
                <div className={`num text-sm font-semibold ${pnl >= 0 ? "text-profit" : "text-loss"}`}>{pnl >= 0 ? "+" : ""}{usd(pnl)}</div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </Glass>
  );
}

function SignalFeed() {
  const [rows, setRows] = useState<JournalRow[]>([]);
  const tick = useStore((s) => s.journalTick);
  useEffect(() => {
    api<{ decisions: JournalRow[] }>("/api/journal?limit=25").then((d) => setRows(d.decisions)).catch(() => undefined);
  }, [tick]);
  const tone: Record<string, string> = { taken: "border-profit/50 text-emerald-300", vetoed: "border-loss/50 text-rose-300", skipped: "border-warn/50 text-amber-200", error: "border-loss/50 text-rose-300" };
  return (
    <Glass className="flex h-full min-h-0 flex-col p-4" title="Signal feed">
      <div className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        {!rows.length && <p className="py-6 text-center text-sm text-slate-500">No signals yet. Sweeps appear here the moment the Hunter finds one.</p>}
        <AnimatePresence initial={false}>
          {rows.map((r) => (
            <motion.div key={r.id} layout initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}
              className="flex items-start gap-2 rounded-lg border border-white/[0.05] bg-black/20 px-3 py-2 text-[12px]">
              <span className={`chip flex-none ${tone[r.outcome] ?? "border-white/10 text-slate-300"}`}>{r.outcome}</span>
              <div className="min-w-0">
                <div className="text-slate-200"><b>{r.instrument}</b> · <span className="num text-slate-500">{dateTime(r.ts)}</span></div>
                <div className="truncate text-slate-400">{r.summary}</div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Glass>
  );
}

export function SignalsView() {
  const account = useStore((s) => s.account);
  const env = useStore((s) => s.deltaEnv);
  const tag = env === "testnet" ? "DEMO" : "LIVE";
  const accountEmpty = account?.error ? `Account positions unavailable: ${account.error}` : account?.updated_at ? "No open positions on your Delta account." : "Waiting for the first account sync…";
  return (
    <div className="grid h-full grid-cols-1 gap-3 overflow-y-auto pb-2 xl:grid-cols-2">
      <div className="flex min-h-0 flex-col gap-3">
        <PositionList title={`Delta India ${tag} account positions (synced every 3s)`} positions={account?.positions ?? []} empty={accountEmpty} />
        <div className="min-h-[300px] flex-1"><SignalFeed /></div>
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        <DeltaStatusCard />
        <DeltaFills />
        <div className="min-h-[280px] flex-1"><DeltaExecutionLog /></div>
      </div>
    </div>
  );
}
