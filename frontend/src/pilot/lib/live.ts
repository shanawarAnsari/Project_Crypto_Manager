import { useStore, type State } from "../store/useStore";
import { api } from "./api";
import { play } from "./sound";
import type {
  AccountState, AgentResult, Candle, CycleSummary, DeltaHealth, ExecLogRow, Instrument, Kpis, Params, Position, Quotes, Rules, SessionInfo,
  Toast
} from "./types";

const S = () => useStore.getState();

/** Load the full desk snapshot (called on boot, reconnects and mode changes). */
export async function loadState(): Promise<void> {
  const d = await api<Record<string, unknown>>("/api/state");
  const instruments = (d.instruments as string[]) ?? [];
  const specs = (d.specs ?? {}) as Record<string, { digits: number }>;
  S().set((s) => ({
    loaded: true, mode: d.mode as string, dataSource: d.data_source as State["dataSource"], execution: d.execution as State["execution"],
    banner: (d.banner as string | null) ?? null, analystMode: d.analyst_mode as string, model: d.model as string, instruments,
    instrument: instruments.includes(s.instrument) ? s.instrument : instruments[0] ?? "BTCUSD",
    kpis: d.kpis as Kpis, positions: d.positions as Position[], equity: d.equity_curve as State["equity"], session: d.session as SessionInfo,
    rules: d.rules as Rules, params: d.params as Params, delta: d.delta as DeltaHealth, deltaEnv: d.delta_env as State["deltaEnv"],
    maxLeverage: d.max_leverage as number, confirmPhrase: d.confirm_phrase as string, paused: Boolean(d.paused),
    lastCycle: (d.last_cycle ?? {}) as State["lastCycle"], account: d.account as AccountState, quotes: (d.quotes ?? {}) as Quotes,
    digits: Object.fromEntries(Object.entries(specs).map(([k, v]) => [k, v.digits]))
  }));
}

/** Merge REST history with any bars that streamed in while the request was in flight. */
export async function loadCandles(instrument: Instrument): Promise<void> {
  const source = S().dataSource;
  const before = new Map((S().candles[instrument] ?? []).map((c) => [c.time, c]));
  const d = await api<{ ok: boolean; candles?: Candle[]; message?: string }>(`/api/candles?instrument=${instrument}&n=500`);
  if (!d.ok || !d.candles) throw new Error(d.message ?? `Could not load ${instrument} candle history`);
  const history = d.candles;
  if (S().dataSource !== source) return;
  S().set((s) => {
    const byTime = new Map(history.map((c) => [c.time, c]));
    for (const c of s.candles[instrument] ?? []) {
      if (c.time > (history.at(-1)?.time ?? 0) || c !== before.get(c.time)) byTime.set(c.time, c);
    }
    return { candles: { ...s.candles, [instrument]: [...byTime.values()].sort((a, b) => a.time - b.time).slice(-800) } };
  });
}

export async function loadExecLog(): Promise<void> {
  const d = await api<{ log: ExecLogRow[] }>("/api/delta/log?limit=80");
  S().set({ execLog: d.log });
}

/** Loose union of the fields carried by stream frames; each case narrows what it reads. */
interface FrameData {
  account: AccountState;
  quotes: Quotes;
  candles: Record<string, Candle>;
  kpis: Kpis;
  positions: Position[];
  session: SessionInfo;
  mode: string;
  equity_point?: { time: number; equity: number };
  data_source: State["dataSource"];
  execution: State["execution"];
  banner: string | null;
  rules: Rules;
  params: Params;
  engaged: boolean;
  paused: boolean;
  progress: number;
  venue: string;
  type: string;
}

type Msg = { type: string; data: unknown; ts: number };

export function handle(msg: Msg): void {
  const s = S();
  const d = msg.data as FrameData;
  switch (msg.type) {
    case "agent": {
      const r = msg.data as AgentResult;
      s.onAgent(r);
      if (r.status === "veto") play("veto");
      break;
    }
    case "cycle_end": {
      const c = msg.data as CycleSummary;
      s.set((st) => {
        const prev = st.lastCycle[c.instrument];
        const lastCycle = c.setup || !prev ? { ...st.lastCycle, [c.instrument]: c } : { ...st.lastCycle, [c.instrument]: { ...prev, levels: c.levels } };
        return { lastCycle, journalTick: c.setup ? st.journalTick + 1 : st.journalTick };
      });
      break;
    }
    case "market":
      Object.entries(d.candles ?? {}).forEach(([i, c]) => s.appendCandle(i, c));
      s.set((st) => ({
        kpis: d.kpis, positions: d.positions, session: d.session, mode: d.mode, account: d.account ?? st.account,
        quotes: d.quotes ?? st.quotes, banner: d.banner ?? null, equity: d.equity_point ? [...st.equity, d.equity_point].slice(-800) : st.equity
      }));
      break;
    case "toast":
      s.pushToast(msg.data as Omit<Toast, "id">);
      break;
    case "trade_placed":
      play("trade");
      if (d.venue === "delta") s.set((st) => ({ deltaPulse: st.deltaPulse + 1 }));
      break;
    case "position_event":
      if (d.type === "tp1" || d.type === "tp2") {
        s.set((st) => ({ confettiKey: st.confettiKey + 1 }));
        play("tp");
      }
      s.set((st) => ({ journalTick: st.journalTick + 1 }));
      break;
    case "delta_status":
      s.set({ delta: msg.data as DeltaHealth, mode: d.mode });
      break;
    case "delta_sync":
      s.set((st) => ({
        account: d.account ?? st.account, ...(d.positions ? { positions: d.positions } : {}),
        ...(d.equity_point ? { equity: [...st.equity, d.equity_point].slice(-800) } : {})
      }));
      break;
    case "delta_log": {
      const row = msg.data as ExecLogRow;
      s.set((st) => ({ execLog: [row, ...st.execLog].slice(0, 120), deltaPulse: row.kind === "order_filled" ? st.deltaPulse + 1 : st.deltaPulse }));
      break;
    }
    case "mode":
      s.set({ mode: d.mode, dataSource: d.data_source, execution: d.execution, banner: d.banner ?? null, lastCycle: {}, candles: {}, quotes: {} });
      void loadState().then(() => loadCandles(S().instrument)).catch(() => undefined);
      break;
    case "settings":
      s.set({ rules: d.rules, params: d.params });
      break;
    case "kill_switch":
      play("kill");
      s.set((st) => ({ kpis: st.kpis ? { ...st.kpis, kill_switch: d.engaged } : st.kpis }));
      break;
    case "paused":
      s.set({ paused: d.paused });
      break;
    case "backtest_progress":
      s.set({ backtestProgress: d.progress });
      break;
    case "review":
      s.set((st) => ({ journalTick: st.journalTick + 1 }));
      break;
    default:
      break;
  }
}

/** Connect to /api/ws with exponential-backoff reconnects. */
export function connectLive(): () => void {
  let ws: WebSocket | null = null;
  let retry = 0;
  let closed = false;
  let ping: number | undefined;
  let reconnect: number | undefined;
  const open = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    ws.onopen = () => {
      if (retry > 0) S().pushToast({ level: "success", title: "Reconnected", message: "Live agent stream restored." });
      retry = 0;
      S().set({ wsConnected: true });
      void loadState().then(() => loadCandles(S().instrument)).catch(() => undefined);
      void loadExecLog().catch(() => undefined);
      ping = window.setInterval(() => ws?.readyState === 1 && ws.send("ping"), 20_000);
    };
    ws.onmessage = (e) => {
      try {
        handle(JSON.parse(String(e.data)) as Msg);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      window.clearInterval(ping);
      S().set({ wsConnected: false });
      if (closed) return;
      if (retry === 1) S().pushToast({ level: "warning", title: "Live stream lost", message: "Reconnecting to the agent desk..." });
      retry += 1;
      reconnect = window.setTimeout(open, Math.min(8000, 500 * 2 ** retry));
    };
  };
  open();
  return () => {
    closed = true;
    window.clearTimeout(reconnect);
    window.clearInterval(ping);
    ws?.close();
  };
}
