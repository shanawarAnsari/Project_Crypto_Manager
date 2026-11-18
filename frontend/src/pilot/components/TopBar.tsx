import { motion } from "framer-motion";
import { Wordmark } from "./Logo";
import { useStore } from "../store/useStore";
import { post } from "../lib/api";
import { px } from "../lib/format";

const MODE_STYLE: Record<string, string> = {
  DEMO: "border-cyan-neon/50 text-cyan-200 bg-cyan-500/10",
  PAPER: "border-violet-neon/50 text-violet-200 bg-violet-500/10",
  "DELTA DEMO": "border-profit/60 text-emerald-200 bg-emerald-500/10",
  "DELTA LIVE": "border-loss text-white bg-loss/70 shadow-loss",
};

export function ModePill() {
  const mode = useStore((s) => s.mode);
  return (
    <span data-cursor="Mode" className={`chip font-mono tracking-widest ${MODE_STYLE[mode] ?? MODE_STYLE.DEMO}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${mode === "DELTA LIVE" ? "bg-white animate-pulse" : "bg-current"}`} />
      {mode}
    </span>
  );
}

/** Session badge with a day/night arc: the sun travels across the UTC day. */
export function SessionBadge() {
  const s = useStore((st) => st.session);
  if (!s) return <div className="skeleton h-9 w-40 rounded-xl" />;
  const p = s.day_progress;
  const ang = Math.PI * (1 - p);
  const cx = 22 + Math.cos(ang) * 18;
  const cy = 22 - Math.sin(ang) * 14;
  const night = p < 0.25 || p > 0.875;
  const color = s.session === "LONDON" ? "#22d3ee" : s.session === "NEW_YORK" ? "#8b5cf6" : s.session === "ASIAN" ? "#f59e0b" : "#64748b";
  return (
    <div data-cursor="Session" className="glass flex items-center gap-2 rounded-xl px-2.5 py-1">
      <svg width="44" height="26" viewBox="0 0 44 26" aria-hidden>
        <path d="M4 22 A18 14 0 0 1 40 22" fill="none" stroke="rgba(255,255,255,.15)" strokeDasharray="2 3" />
        <circle cx={cx} cy={cy} r="4" fill={night ? "#c7d2fe" : "#fcd34d"} style={{ filter: `drop-shadow(0 0 4px ${night ? "#a5b4fc" : "#fbbf24"})` }} />
        <line x1="2" x2="42" y1="22.5" y2="22.5" stroke="rgba(255,255,255,.2)" />
      </svg>
      <div className="leading-tight">
        <div className="text-[11px] font-semibold" style={{ color }}>{s.session.replace("_", " ")}</div>
        <div className="num text-[10px] text-slate-400">{s.utc} UTC · {s.ist} IST</div>
      </div>
    </div>
  );
}

/** Live Delta India mark prices (or demo-feed closes) for every desk instrument. */
export function LiveTicker() {
  const instruments = useStore((s) => s.instruments);
  const quotes = useStore((s) => s.quotes);
  const candles = useStore((s) => s.candles);
  const instrument = useStore((s) => s.instrument);
  const dataSource = useStore((s) => s.dataSource);
  const set = useStore((s) => s.set);
  return (
    <div className="hidden items-center gap-1.5 xl:flex" data-cursor="Switch">
      {instruments.map((i) => {
        const q = quotes[i];
        const price = q?.mark ?? candles[i]?.at(-1)?.close;
        const stale = q ? Date.now() / 1000 - q.updated_at > 30 : true;
        return (
          <button key={i} onClick={() => set({ instrument: i })}
            title={dataSource === "delta" ? (stale ? "Quote is stale" : "Live Delta India mark price") : "Demo feed"}
            className={`glass flex items-center gap-2 rounded-xl px-2.5 py-1 text-left transition ${instrument === i ? "ring-1 ring-cyan-neon/50" : "opacity-80 hover:opacity-100"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${dataSource === "delta" && !stale ? "bg-profit animate-pulse" : "bg-slate-500"}`} />
            <span className="text-[11px] font-semibold text-slate-200">{i}</span>
            <span className="num text-[12px] text-white">{px(price, i)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TopBar() {
  const beginner = useStore((s) => s.beginner);
  const sound = useStore((s) => s.sound);
  const toggle = useStore((s) => s.toggle);
  const set = useStore((s) => s.set);
  const wsConnected = useStore((s) => s.wsConnected);
  const dataSource = useStore((s) => s.dataSource);
  const paused = useStore((s) => s.paused);
  const runScenario = async () => {
    const r = await post<{ ok: boolean; message?: string; instrument?: string }>("/api/demo/scenario", { instrument: useStore.getState().instrument });
    if (!r.ok) useStore.getState().pushToast({ level: "warning", title: "Scenario", message: r.message ?? "Unavailable" });
    else if (r.instrument) useStore.getState().set({ instrument: r.instrument });
  };
  const togglePause = () => { post("/api/pause", { paused: !paused }).catch(() => undefined); };
  return (
    <header className="relative z-40 flex h-14 items-center gap-3 border-b border-white/[0.06] bg-space-900/70 px-4 backdrop-blur-xl">
      <Wordmark compact />
      <div className="ml-2 hidden items-center gap-2 md:flex">
        <ModePill />
        <span title={wsConnected ? "Live stream connected" : "Reconnecting"} className={`h-2 w-2 rounded-full ${wsConnected ? "bg-profit shadow-profit" : "bg-warn animate-pulse"}`} />
      </div>
      <LiveTicker />
      <div className="mx-auto hidden lg:block xl:hidden 2xl:block"><SessionBadge /></div>
      <div className="ml-auto flex items-center gap-2">
        <button onClick={togglePause} data-cursor={paused ? "Resume" : "Pause"} className={`btn-ghost px-2.5 py-1.5 text-xs ${paused ? "text-amber-200" : ""}`}
          title={paused ? "Agents paused: no new trades. Click to resume." : "Pause the agent pipeline"}>
          {paused ? "▶ Resume" : "❚❚ Pause"}
        </button>
        {dataSource === "demo" && <motion.button
          data-tour="scenario"
          data-cursor="Play"
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.95 }}
          title="Plant a sweep setup on the demo feed"
          onClick={runScenario}
          className="btn-primary px-3 py-1.5 text-xs"
        >
          ▶ Run Demo Scenario
        </motion.button>}
        <button onClick={() => toggle("beginner")} data-cursor="Toggle" className="btn-ghost px-2.5 py-1.5 text-xs">
          <span className={beginner ? "text-cyan-200" : "text-slate-500"}>Beginner</span>
          <span className="text-slate-600">/</span>
          <span className={!beginner ? "text-violet-200" : "text-slate-500"}>Pro</span>
        </button>
        <button onClick={() => toggle("sound")} data-cursor={sound ? "Mute" : "Sound"} aria-label="Toggle sound" className="btn-ghost px-2.5 py-1.5 text-xs">
          {sound ? "🔊" : "🔇"}
        </button>
        <button onClick={() => set({ paletteOpen: true })} data-cursor="Search" className="btn-ghost hidden px-2.5 py-1.5 font-mono text-[11px] md:inline-flex">
          Ctrl K
        </button>
      </div>
    </header>
  );
}
