import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Glass } from "../components/Glass";
import { api, post } from "../lib/api";
import { dateTime, usd } from "../lib/format";
import { useStore } from "../store/useStore";
import { AGENTS, type JournalRow } from "../lib/types";

interface Review { day: string; ts: number; text: string }
interface Trade { id: string; instrument: string; direction: string; pnl: number; closed_at: number; reason: string; venue: string }

const TONE: Record<string, string> = {
  taken: "bg-profit border-profit/60", vetoed: "bg-loss border-loss/60", skipped: "bg-warn border-warn/60", error: "bg-loss border-loss/60",
};

export function JournalView() {
  const [rows, setRows] = useState<JournalRow[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [open, setOpen] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const beginner = useStore((s) => s.beginner);
  const tick = useStore((s) => s.journalTick);

  useEffect(() => {
    const q = filter === "all" ? "" : `&outcome=${filter}`;
    api<{ decisions: JournalRow[]; trades: Trade[]; reviews: Review[] }>(`/api/journal?limit=150${q}`)
      .then((d) => { setRows(d.decisions); setTrades(d.trades); setReviews(d.reviews); })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [filter, tick]);

  const genReview = async () => {
    setReviewing(true);
    try {
      const r = await post<{ day: string; text: string }>("/api/review");
      setReviews((prev) => [{ day: r.day, ts: Date.now() / 1000, text: r.text }, ...prev.filter((x) => x.day !== r.day)]);
    } catch { /* toast shown */ } finally { setReviewing(false); }
  };

  return (
    <div className="grid h-full gap-3 overflow-hidden xl:grid-cols-[1.6fr_1fr]">
      <Glass className="flex min-h-0 flex-col p-4" title="Decision timeline" right={
        <div className="flex gap-1">
          {["all", "taken", "vetoed", "skipped"].map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`rounded-md px-2.5 py-1 text-[11px] capitalize ${filter === f ? "bg-cyan-500/15 text-white" : "text-slate-400 hover:text-slate-200"}`}>{f}</button>
          ))}
        </div>}>
        <div className="relative mt-3 min-h-0 flex-1 overflow-y-auto pl-6 pr-1">
          <div className="absolute bottom-0 left-[11px] top-0 w-px bg-gradient-to-b from-cyan-neon/50 via-violet-neon/30 to-transparent" />
          {loading && [0, 1, 2, 3].map((i) => <div key={i} className="skeleton mb-3 h-14 rounded-xl" />)}
          {!loading && !rows.length && <p className="py-10 text-center text-sm text-slate-500">No decisions yet. Every taken, vetoed and skipped setup is journaled here with its full agent trace.</p>}
          {rows.map((r) => (
            <div key={r.id} className="relative mb-2.5">
              <span className={`absolute -left-[19px] top-3.5 h-2.5 w-2.5 rounded-full border-2 ${TONE[r.outcome] ?? "bg-slate-500"}`} />
              <button onClick={() => setOpen(open === r.id ? null : r.id)} data-cursor={open === r.id ? "Collapse" : "Expand trace"}
                className="w-full rounded-xl border border-white/[0.06] bg-black/20 p-3 text-left hover:bg-white/[0.04]">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="font-display font-semibold uppercase tracking-wider text-white">{r.outcome}</span>
                  <span className="text-slate-300">{r.instrument}</span>
                  <span className="num ml-auto text-slate-500">{dateTime(r.ts)}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-[12px] text-slate-400">{r.summary}</div>
              </button>
              <AnimatePresence>
                {open === r.id && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <ol className="mt-2 space-y-1.5 pl-2">
                      {r.trace.map((t, i) => (
                        <li key={i} className="rounded-lg border border-white/[0.05] bg-black/30 p-2.5 text-[11.5px]">
                          <div className="flex items-center gap-2">
                            <span className="h-2 w-2 rounded-full" style={{ background: AGENTS.find((a) => a.name === t.agent)?.color }} />
                            <b className="text-white">{t.agent}</b>
                            <span className="uppercase text-slate-500">{t.status}</span>
                            <span className="num ml-auto text-slate-500">{t.latency_ms} ms</span>
                          </div>
                          <div className="mt-1 text-slate-300">{t.summary}</div>
                          {!beginner && t.agent === "Guardian" && Array.isArray((t.data as { checks?: unknown[] }).checks) && (
                            <div className="mt-1.5 grid grid-cols-2 gap-1">
                              {((t.data as { checks: { name: string; passed: boolean; detail: string }[] }).checks).map((c) => (
                                <div key={c.name} className={`rounded px-1.5 py-0.5 ${c.passed ? "text-emerald-300" : "text-rose-300"}`}>{c.passed ? "✓" : "✕"} {c.name}: <span className="text-slate-400">{c.detail}</span></div>
                              ))}
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </Glass>
      <div className="flex min-h-0 flex-col gap-3">
        <Glass className="p-4" title="AI daily review" glow="violet" right={
          <button onClick={genReview} disabled={reviewing} className="btn-ghost px-3 py-1 text-xs">{reviewing ? "Writing…" : "Generate now"}</button>}>
          <div className="mt-3 max-h-[300px] space-y-3 overflow-y-auto">
            {!reviews.length && <p className="text-sm text-slate-500">The Chronicler writes a review at the end of each trading day. Click "Generate now" for today's.</p>}
            {reviews.map((r) => (
              <div key={r.day} className="rounded-xl border border-violet-neon/20 bg-violet-500/[0.06] p-3">
                <div className="label text-violet-300">{r.day}</div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-slate-200">{r.text}</p>
              </div>
            ))}
          </div>
        </Glass>
        <Glass className="flex min-h-0 flex-1 flex-col p-4" title="Closed trades">
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
            {!trades.length && <p className="py-4 text-sm text-slate-500">No closed trades yet.</p>}
            {trades.map((t) => (
              <div key={t.id} className="num flex items-center justify-between border-b border-white/[0.04] py-1.5 text-[11.5px]">
                <span className="text-slate-300">{t.instrument} {t.direction}</span>
                <span className="text-slate-500">{t.reason}</span>
                <span className={t.pnl >= 0 ? "text-profit" : "text-loss"}>{t.pnl >= 0 ? "+" : ""}{usd(t.pnl)}</span>
              </div>
            ))}
          </div>
        </Glass>
      </div>
    </div>
  );
}
