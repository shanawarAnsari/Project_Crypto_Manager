import { px, time } from "../api";
import { useDesk } from "../store";
import { AGENTS, type AgentStatus, type CycleSummary } from "../types";

const STATUS_STYLE: Record<AgentStatus, string> = {
  ok: "border-emerald-400/50 bg-emerald-400/10 text-emerald-300",
  skip: "border-terminal-border bg-white/[0.02] text-terminal-muted",
  veto: "border-amber-400/50 bg-amber-400/10 text-amber-300",
  error: "border-red-500/50 bg-red-500/10 text-red-300"
};
const OUTCOME_STYLE: Record<string, string> = {
  taken: "border-emerald-400/50 text-emerald-300", vetoed: "border-red-500/50 text-red-300", skipped: "border-amber-400/50 text-amber-300",
  error: "border-red-500/50 text-red-300", none: "border-terminal-border text-terminal-muted"
};

function checklist(c: CycleSummary, mult: number) {
  const s = c.setup!;
  const chk = (n: string) => c.checks.find((x) => x.name === n);
  const approved = c.outcome === "taken" || (c.checks.length > 0 && c.checks.every((x) => x.passed));
  return [
    { label: "Level swept", ok: true, detail: `${s.level.name} @ ${s.level.price}` },
    { label: "Depth in range", ok: true, detail: `${s.extension_depth}% beyond the level` },
    { label: "Displacement strong", ok: s.displacement_ratio >= mult, detail: `${s.displacement_ratio}× avg body${s.volume_spike ? " + volume spike" : ""}` },
    { label: "Session", ok: chk("Session")?.passed ?? null, detail: chk("Session")?.detail ?? s.session },
    { label: "RR ≥ minimum", ok: chk("Risk:Reward")?.passed ?? null, detail: chk("Risk:Reward")?.detail ?? `1:${s.risk_reward_ratio}` },
    {
      label: "Guardian approved", ok: c.checks.length ? approved : null,
      detail: c.checks.length ? (approved ? "All AEGIS checks passed" : c.checks.filter((x) => !x.passed).map((x) => x.name).join(", ")) : c.outcome === "skipped" ? "Analyst said NO_TRADE" : "Pending"
    }
  ];
}

export function WhyThisTrade() {
  const instrument = useDesk((s) => s.instrument);
  const cycle = useDesk((s) => s.lastCycle[s.instrument]);
  const mult = useDesk((s) => s.params?.displacement_mult ?? 1.2);
  const digits = useDesk((s) => s.digits[s.instrument] ?? 2);
  const dataSource = useDesk((s) => s.dataSource);

  if (!cycle?.setup) {
    return (
      <section className="panel h-full">
        <header className="panel-head"><h2 className="panel-title">Why this trade? · {instrument}</h2></header>
        <div className="p-4 text-sm text-terminal-muted">
          <p className="flex items-center gap-2"><i className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />The Hunter is scanning every 5M close for a liquidity sweep.</p>
          {dataSource === "demo" && <p className="mt-2">Press <b className="text-terminal-text">Run Demo Scenario</b> to watch one play out in ~30 seconds.</p>}
        </div>
      </section>
    );
  }
  const s = cycle.setup;
  const d = cycle.decision;
  const conf = d?.confidence_score ?? 0;
  return (
    <section className="panel h-full">
      <header className="panel-head">
        <h2 className="panel-title">Why this trade? · {s.instrument} {s.direction}</h2>
        <span className={`pill ${OUTCOME_STYLE[cycle.outcome] ?? ""}`}>{cycle.outcome.toUpperCase()}</span>
      </header>
      <div className="space-y-3 p-4">
        <div className="flex items-start gap-4">
          <ul className="min-w-0 flex-1 space-y-1.5">
            {checklist(cycle, mult).map((it) => (
              <li key={it.label} className="flex items-start gap-2 text-[13px]">
                <span className={`mt-0.5 grid h-4 w-4 flex-none place-items-center rounded-full text-[10px] font-bold ${it.ok === null ? "bg-white/10 text-terminal-muted" : it.ok ? "bg-emerald-400/20 text-emerald-300" : "bg-red-500/20 text-red-300"}`}>
                  {it.ok === null ? "…" : it.ok ? "✓" : "✕"}
                </span>
                <span className="min-w-0">
                  <span className="text-terminal-text">{it.label}</span>
                  <span className="block truncate text-[11px] text-terminal-muted">{it.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          {d && (
            <div className="grid h-16 w-16 flex-none place-items-center rounded-full border-4" style={{ borderColor: conf >= 7 ? "#35d39a" : conf >= 5 ? "#f0b968" : "#f07178" }} aria-label={`Confidence ${conf} of 10`}>
              <div className="text-center"><b className="num text-lg text-terminal-text">{conf}</b><span className="block text-[9px] text-terminal-muted">/10</span></div>
            </div>
          )}
        </div>
        {d && (
          <div className="rounded-lg border border-violet-400/25 bg-violet-500/[0.07] p-3">
            <p className="mb-1 text-[10px] uppercase tracking-widest text-violet-300">Analyst reasoning</p>
            <p className="text-[12.5px] leading-relaxed text-terminal-text">{d.reasoning}</p>
          </div>
        )}
        <div className="grid grid-cols-4 gap-1.5 text-center">
          {([["Entry", s.entry_price, "text-terminal-text"], ["SL", s.stop_loss, "text-terminal-red"], ["TP1", s.take_profit_1, "text-terminal-green"], ["TP2", s.take_profit_2, "text-terminal-green"]] as const).map(([k, v, c]) => (
            <div key={k} className="rounded-md bg-black/25 px-1 py-1.5">
              <div className="label">{k}</div>
              <div className={`num text-[12px] ${c}`}>{px(v, digits)}</div>
            </div>
          ))}
        </div>
        {cycle.checks.length > 0 && (
          <details className="text-[12px]">
            <summary className="cursor-pointer text-terminal-muted">AEGIS checks ({cycle.checks.filter((c) => c.passed).length}/{cycle.checks.length} passed)</summary>
            <ul className="mt-2 space-y-1">
              {cycle.checks.map((c) => (
                <li key={c.name} className="flex justify-between gap-3">
                  <span className={c.passed ? "text-emerald-300" : "text-red-300"}>{c.passed ? "✓" : "✕"} {c.name}</span>
                  <span className="truncate text-right text-terminal-muted">{c.detail}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

export function Pipeline() {
  const instrument = useDesk((s) => s.instrument);
  const status = useDesk((s) => s.agentStatus);
  return (
    <section className="panel">
      <header className="panel-head"><h2 className="panel-title">Agent pipeline · {instrument}</h2><span className="text-[11px] text-terminal-muted">runs on every 5M close</span></header>
      <ol className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-7">
        {AGENTS.map((a, i) => {
          const r = status[`${instrument}:${a.name}`];
          return (
            <li key={a.name} className={`rounded-lg border p-2.5 ${r ? STATUS_STYLE[r.status] : "border-terminal-border text-terminal-muted"}`} title={a.blurb}>
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold" style={{ color: a.color }}>{i + 1}. {a.name}</span>
                {r && <span className="text-[9px] uppercase">{r.status}</span>}
              </div>
              <div className="label mt-0.5">{a.role}</div>
              <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-terminal-text/80">{r?.summary ?? "Waiting for the next close…"}</p>
              {r && <p className="num mt-1 text-[10px] text-terminal-muted">{time(r.timestamp)} · {r.latency_ms}ms</p>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function AgentFeed() {
  const feed = useDesk((s) => s.feed);
  const rows = feed.filter((r) => r.status !== "skip" || r.agent === "Hunter").slice(0, 60);
  return (
    <section className="panel flex h-full flex-col">
      <header className="panel-head"><h2 className="panel-title">Live agent feed</h2><span className="text-[11px] text-terminal-muted">{feed.length} events</span></header>
      <ul className="max-h-[360px] min-h-[200px] flex-1 space-y-1 overflow-y-auto p-3 text-[12px]">
        {!rows.length && <li className="py-6 text-center text-terminal-muted">Waiting for agents…</li>}
        {rows.map((r, i) => (
          <li key={`${r.cycle_id}-${r.agent}-${i}`} className="flex gap-2 border-b border-white/[0.04] pb-1">
            <span className="num w-[58px] flex-none text-terminal-muted">{time(r.timestamp)}</span>
            <span className="w-[62px] flex-none text-terminal-muted">{r.instrument}</span>
            <span className="w-[84px] flex-none font-semibold" style={{ color: AGENTS.find((a) => a.name === r.agent)?.color }}>{r.agent}</span>
            <span className={`min-w-0 ${r.status === "veto" ? "text-amber-300" : r.status === "error" ? "text-red-300" : "text-terminal-text/90"}`}>{r.summary}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
