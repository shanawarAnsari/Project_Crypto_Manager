import { AGENTS, type AgentStatus } from "../lib/types";
import { useStore } from "../store/useStore";

const STATUS_STYLE: Record<AgentStatus, string> = {
  ok: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
  skip: "border-white/10 bg-white/[0.04] text-slate-400",
  veto: "border-rose-500/25 bg-rose-500/10 text-rose-300",
  error: "border-amber-500/25 bg-amber-500/10 text-amber-200",
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  ok: "Complete",
  skip: "No setup",
  veto: "Vetoed",
  error: "Error",
};

const ACTIVITY_COLOR: Record<AgentStatus, string> = {
  ok: "bg-emerald-400",
  skip: "bg-slate-500",
  veto: "bg-rose-400",
  error: "bg-amber-300",
};

export function OverviewView() {
  const instrument = useStore((s) => s.instrument);
  const agents = useStore((s) => s.agents);
  const ticker = useStore((s) => s.ticker);
  const cycle = useStore((s) => s.lastCycle[instrument]);
  const dataSource = useStore((s) => s.dataSource);
  const execution = useStore((s) => s.execution);
  const deltaEnv = useStore((s) => s.deltaEnv);
  const paused = useStore((s) => s.paused);
  const wsConnected = useStore((s) => s.wsConnected);
  const positions = useStore((s) => s.positions);

  const stats = [
    {
      label: "Market data",
      value: dataSource === "delta" ? "Delta Exchange" : "Synthetic demo",
      note: "Closed 5-minute candles",
    },
    {
      label: "Order routing",
      value: execution === "delta" ? `Delta ${deltaEnv === "testnet" ? "Demo" : "Live"}` : "Paper",
      note: execution === "delta" ? "Exchange execution" : "Simulation only",
    },
    {
      label: "Open positions",
      value: String(positions.length),
      note: instrument,
    },
    {
      label: "Strategy",
      value: paused ? "Paused" : "Monitoring",
      note: paused ? "No new orders" : "Risk checks active",
    },
  ];

  return (
    <div className="h-full overflow-y-auto rounded-2xl border border-white/[0.07] bg-slate-950/60 p-4 md:p-5" data-tour="overview" data-testid="overview">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="label">Trading desk</div>
          <h1 className="mt-1 font-display text-2xl font-semibold text-white">Overview</h1>
          <p className="mt-1 text-sm text-slate-400">Strategy status and recent decisions for {instrument}.</p>
        </div>
        <span className={`chip ${wsConnected ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300" : "border-amber-500/25 bg-amber-500/10 text-amber-200"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${wsConnected ? "bg-emerald-400" : "animate-pulse bg-amber-300"}`} />
          {wsConnected ? "Desk connected" : "Reconnecting"}
        </span>
      </header>

      <section aria-label="Desk status" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="min-w-0 rounded-xl border border-white/[0.07] bg-white/[0.025] px-3 py-2.5">
            <div className="label truncate">{stat.label}</div>
            <div className="mt-1 truncate text-sm font-semibold text-slate-100">{stat.value}</div>
            <div className="mt-0.5 truncate text-[11px] text-slate-500">{stat.note}</div>
          </div>
        ))}
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(260px,0.85fr)]">
        <section className="min-w-0 rounded-xl border border-white/[0.07] bg-white/[0.02]">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-100">Decision pipeline</h2>
              <p className="mt-0.5 text-xs text-slate-500">Latest result from each strategy stage</p>
            </div>
            <span className="text-xs text-slate-500">{AGENTS.length} stages</span>
          </div>
          <ol className="divide-y divide-white/[0.05]">
            {AGENTS.map((agent, index) => {
              const result = agents[agent.name]?.last;
              const status = result?.status;
              return (
                <li key={agent.name} className="flex min-w-0 items-center gap-2.5 px-3 py-3 sm:gap-3 sm:px-4">
                  <span className="num w-5 flex-none text-[11px] text-slate-600">{String(index + 1).padStart(2, "0")}</span>
                  <div className="w-[105px] flex-none sm:w-[128px]">
                    <div className="text-[13px] font-medium text-slate-200">{agent.name}</div>
                    <div className="truncate text-[10px] text-slate-500">{agent.role}</div>
                  </div>
                  <p className="min-w-0 flex-1 truncate text-xs text-slate-400" title={result?.summary}>
                    {result?.summary ?? "Waiting for the first update"}
                  </p>
                  <span className={`chip flex-none px-2 py-0.5 text-[10px] ${status ? STATUS_STYLE[status] : "border-white/10 bg-white/[0.03] text-slate-500"}`}>
                    {status ? STATUS_LABEL[status] : "Waiting"}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>

        <div className="flex min-w-0 flex-col gap-4">
          <section className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
            <div className="border-b border-white/[0.06] px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-100">Latest scan</h2>
              <p className="mt-0.5 text-xs text-slate-500">{instrument} · closed 5-minute candle</p>
            </div>
            <div className="p-4">
              {cycle?.setup ? (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-white">{cycle.setup.direction} setup</span>
                    <span className={`chip ${cycle.outcome === "taken" ? STATUS_STYLE.ok : cycle.outcome === "vetoed" ? STATUS_STYLE.veto : STATUS_STYLE.skip}`}>
                      {cycle.outcome === "taken" ? "Order submitted" : cycle.outcome === "vetoed" ? "Risk veto" : cycle.outcome}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-400">{cycle.setup.level.name} liquidity sweep detected.</p>
                </>
              ) : (
                <p className="text-sm leading-relaxed text-slate-400">
                  No qualifying sweep on the latest scan. The strategy continues to wait for a confirmed setup.
                </p>
              )}
            </div>
          </section>

          <section className="min-h-0 flex-1 rounded-xl border border-white/[0.07] bg-white/[0.02]">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">Recent activity</h2>
                <p className="mt-0.5 text-xs text-slate-500">Notable strategy decisions</p>
              </div>
              <span className="text-xs text-slate-500">{ticker.length}</span>
            </div>
            {ticker.length ? (
              <ul className="divide-y divide-white/[0.05]">
                {ticker.slice(0, 5).map((event, index) => (
                  <li key={`${event.timestamp}-${event.agent}-${index}`} className="flex items-start gap-2.5 px-4 py-3">
                    <span className={`mt-1.5 h-2 w-2 flex-none rounded-full ${ACTIVITY_COLOR[event.status]}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-slate-200">{event.agent} · {event.instrument}</span>
                        <time className="num flex-none text-[10px] text-slate-500">
                          {new Date(event.timestamp * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                        </time>
                      </div>
                      <p className="mt-1 truncate text-xs text-slate-400" title={event.summary}>{event.summary}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-5 text-sm text-slate-500">No recent decisions to show.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
