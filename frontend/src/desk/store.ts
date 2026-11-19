import { useSyncExternalStore } from "react";
import { api } from "./api";
import type {
  AccountState, AgentResult, Candle, CycleSummary, DeltaHealth, ExchangePosition, ExecLogRow, Kpis, Params, Quotes, Rules, SessionInfo, Toast
} from "./types";

export interface DeskState {
  connected: boolean;
  loaded: boolean;
  mode: string;
  dataSource: "delta";
  execution: "disabled" | "delta";
  strategyId: string | null;
  executionPermitted: boolean;
  banner: string | null;
  analystMode: string;
  model: string;
  instruments: string[];
  instrument: string;
  kpis: Kpis | null;
  positions: ExchangePosition[];
  equity: { time: number; equity: number }[];
  session: SessionInfo | null;
  rules: Rules | null;
  params: Params | null;
  delta: DeltaHealth | null;
  account: AccountState | null;
  quotes: Quotes;
  deltaEnv: "testnet" | "production";
  maxLeverage: number;
  paused: boolean;
  lastCycle: Record<string, CycleSummary>;
  agentStatus: Record<string, AgentResult>;
  feed: AgentResult[];
  candles: Record<string, Candle[]>;
  candleHistoryLoaded: Record<string, boolean>;
  execLog: ExecLogRow[];
  toasts: Toast[];
  journalTick: number;
  backtestProgress: number;
  digits: Record<string, number>;
}

let state: DeskState = {
  connected: false, loaded: false, mode: "DISCONNECTED", dataSource: "delta", execution: "disabled", strategyId: null, executionPermitted: false, banner: null, analystMode: "catalog", model: "",
  instruments: [], instrument: "BTCUSD", kpis: null, positions: [], equity: [], session: null, rules: null, params: null, delta: null,
  deltaEnv: "testnet", maxLeverage: 2, paused: true, lastCycle: {}, agentStatus: {}, feed: [], candles: {},
  execLog: [], toasts: [], journalTick: 0, backtestProgress: 0, digits: {}, account: null, quotes: {}, candleHistoryLoaded: {}
};
const listeners = new Set<() => void>();

export function getState(): DeskState {
  return state;
}

export function setState(patch: Partial<DeskState> | ((s: DeskState) => Partial<DeskState>)): void {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Selectors must return existing references (or primitives) to avoid render loops. */
export function useDesk<T>(selector: (s: DeskState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

let toastId = 0;
export function pushToast(t: Omit<Toast, "id">): void {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.level === "error" ? 9000 : 5500);
}

export async function loadState(): Promise<void> {
  const d = await api<Record<string, unknown>>("/api/state");
  const instruments = d.instruments as string[];
  const specs = (d.specs ?? {}) as Record<string, { digits: number }>;
  setState((s) => ({
    loaded: true, mode: d.mode as string, dataSource: d.data_source as DeskState["dataSource"], execution: d.execution as DeskState["execution"],
    banner: (d.banner as string | null) ?? null, analystMode: d.analyst_mode as string, model: d.model as string, instruments,
    instrument: instruments.includes(s.instrument) ? s.instrument : instruments[0] ?? "BTCUSD",
    kpis: d.kpis as Kpis, positions: d.positions as ExchangePosition[], equity: d.equity_curve as DeskState["equity"], session: d.session as SessionInfo,
    rules: d.rules as Rules, params: d.params as Params, delta: d.delta as DeltaHealth, deltaEnv: d.delta_env as DeskState["deltaEnv"],
    maxLeverage: d.max_leverage as number, strategyId: typeof d.strategy_id === "string" ? d.strategy_id : null, executionPermitted: d.execution_permitted === true, paused: Boolean(d.paused),
    lastCycle: d.last_cycle as Record<string, CycleSummary>,
    account: d.account as AccountState, quotes: d.quotes as Quotes,
    digits: Object.fromEntries(Object.entries(specs).map(([k, v]) => [k, v.digits]))
  }));
}

export async function loadCandles(instrument: string): Promise<void> {
  const source = getState().dataSource;
  const before = new Map((getState().candles[instrument] ?? []).map((c) => [c.time, c]));
  const d = await api<{ ok: boolean; candles?: Candle[] }>(`/api/candles?instrument=${instrument}&n=500`);
  if (!d.ok || !d.candles) throw new Error(`Could not load ${instrument} candle history`);
  const history = d.candles;
  if (getState().dataSource !== source) return;
  setState((s) => {
    const byTime = new Map(history.map((c) => [c.time, c]));
    for (const c of s.candles[instrument] ?? []) {
      if (c.time > (history.at(-1)?.time ?? 0) || c !== before.get(c.time)) byTime.set(c.time, c);
    }
    return {
      candles: { ...s.candles, [instrument]: [...byTime.values()].sort((a, b) => a.time - b.time).slice(-800) },
      candleHistoryLoaded: { ...s.candleHistoryLoaded, [instrument]: history.length > 0 }
    };
  });
}

export async function loadExecLog(): Promise<void> {
  const d = await api<{ log: ExecLogRow[] }>("/api/delta/log?limit=80");
  setState({ execLog: d.log });
}

function appendCandle(s: DeskState, instrument: string, c: Candle): Record<string, Candle[]> {
  const prev = s.candles[instrument];
  if (!prev) return { ...s.candles, [instrument]: [c] };
  const last = prev.at(-1);
  if (last && c.time < last.time) return s.candles;
  const next = last && last.time === c.time ? [...prev.slice(0, -1), c] : [...prev, c];
  return { ...s.candles, [instrument]: next.slice(-800) };
}

/** Loose union of the fields carried by stream frames; each case narrows what it reads. */
interface FrameData {
  account: AccountState;
  quotes: Quotes;
  candles: Record<string, Candle>;
  kpis: Kpis;
  positions: ExchangePosition[];
  session: SessionInfo;
  mode: string;
  equity_point?: { time: number; equity: number };
  data_source: DeskState["dataSource"];
  execution: DeskState["execution"];
  banner: string | null;
  rules: Rules;
  params: Params;
  engaged: boolean;
  paused: boolean;
  progress: number;
}

type Frame = { type: string; data: unknown; ts: number };

export function handleFrame(msg: Frame): void {
  const d = msg.data as FrameData;
  switch (msg.type) {
    case "agent": {
      const r = msg.data as AgentResult;
      setState((s) => ({ agentStatus: { ...s.agentStatus, [`${r.instrument}:${r.agent}`]: r }, feed: [r, ...s.feed].slice(0, 120) }));
      break;
    }
    case "cycle_end": {
      const c = msg.data as CycleSummary;
      setState((s) => {
        return { lastCycle: { ...s.lastCycle, [c.instrument]: c }, journalTick: c.outcome !== "none" ? s.journalTick + 1 : s.journalTick };
      });
      break;
    }
    case "market":
      setState((s) => {
        let candles = s.candles;
        for (const [inst, c] of Object.entries(d.candles)) candles = appendCandle({ ...s, candles }, inst, c);
        return { candles, kpis: d.kpis, positions: d.positions, session: d.session, mode: d.mode,
          account: d.account ?? s.account, quotes: d.quotes ?? s.quotes, banner: d.banner ?? null,
          equity: d.equity_point ? [...s.equity, d.equity_point].slice(-800) : s.equity };
      });
      break;
    case "toast":
      pushToast(msg.data as Omit<Toast, "id">);
      break;
    case "position_event":
      setState((s) => ({ journalTick: s.journalTick + 1 }));
      break;
    case "delta_status":
      setState({ delta: msg.data as DeltaHealth, mode: d.mode });
      break;
    case "delta_sync":
      setState((s) => ({
        account: d.account, ...(d.positions ? { positions: d.positions } : { positions: s.positions }),
        ...(d.equity_point ? { equity: [...s.equity, d.equity_point].slice(-800) } : {})
      }));
      break;
    case "delta_log":
      setState((s) => ({ execLog: [msg.data as ExecLogRow, ...s.execLog].slice(0, 120) }));
      break;
    case "mode":
      setState({ mode: d.mode, dataSource: d.data_source, execution: d.execution, banner: d.banner ?? null, lastCycle: {}, candles: {}, candleHistoryLoaded: {}, quotes: {} });
      void loadState().then(() => loadCandles(getState().instrument)).catch((error: unknown) =>
        pushToast({ level: "error", title: "Mode sync failed", message: error instanceof Error ? error.message : String(error) }));
      break;
    case "settings":
      setState({ rules: d.rules, params: d.params });
      break;
    case "kill_switch":
      setState((s) => ({ kpis: s.kpis ? { ...s.kpis, kill_switch: d.engaged } : s.kpis }));
      break;
    case "paused":
      setState({ paused: d.paused });
      break;
    case "backtest_progress":
      setState({ backtestProgress: d.progress });
      break;
    case "review":
      setState((s) => ({ journalTick: s.journalTick + 1 }));
      break;
    default:
      break;
  }
}

/** Connect to the desk event stream with exponential-backoff reconnects. */
export function connectLive(): () => void {
  let ws: WebSocket | null = null;
  let retry = 0;
  let closed = false;
  let ping: number | undefined;
  let reconnect: number | undefined;
  const reportError = (error: unknown) => pushToast({
    level: "error", title: "Desk sync failed", message: error instanceof Error ? error.message : String(error)
  });
  const open = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    ws.onopen = () => {
      if (retry > 0) pushToast({ level: "success", title: "Reconnected", message: "Live agent stream restored." });
      retry = 0;
      setState({ connected: true });
      void loadState().then(() => loadCandles(getState().instrument)).catch(reportError);
      void loadExecLog().catch(reportError);
      ping = window.setInterval(() => ws?.readyState === 1 && ws.send("ping"), 20_000);
    };
    ws.onmessage = (e) => {
      try {
        handleFrame(JSON.parse(String(e.data)) as Frame);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      window.clearInterval(ping);
      setState({ connected: false });
      if (closed) return;
      if (retry === 1) pushToast({ level: "warning", title: "Live stream lost", message: "Reconnecting to the desk…" });
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
