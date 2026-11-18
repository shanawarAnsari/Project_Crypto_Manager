import { create } from "zustand";
import type {
  AccountState, AgentName, AgentResult, Candle, CycleSummary, DeltaHealth, ExecLogRow, Instrument, Kpis, Params, Position, Quotes, Rules,
  SessionInfo, Toast, ViewId
} from "../lib/types";
import { safeStorage } from "../config/storage";

const store = safeStorage();
const persisted = (k: string, d: boolean) => {
  const v = store?.getItem(k);
  return v == null ? d : v === "1";
};

export interface AgentLive {
  last?: AgentResult;
  history: AgentResult[];
  pulse: number; // increments on every event (drives beam/orb animation)
  vetoAt: number;
}

export interface State {
  // shell
  view: ViewId;
  beginner: boolean;
  sound: boolean;
  force2D: boolean;
  paletteOpen: boolean;
  wsConnected: boolean;
  loaded: boolean;
  selectedAgent: AgentName | null;
  instrument: Instrument;
  confettiKey: number;
  deltaPulse: number;
  tourOpen: boolean;
  // data
  mode: string;
  dataSource: "demo" | "delta";
  execution: "paper" | "delta";
  banner: string | null;
  analystMode: string;
  model: string;
  instruments: string[];
  digits: Record<string, number>;
  kpis: Kpis | null;
  positions: Position[];
  equity: { time: number; equity: number }[];
  session: SessionInfo | null;
  rules: Rules | null;
  params: Params | null;
  delta: DeltaHealth | null;
  account: AccountState | null;
  quotes: Quotes;
  execLog: ExecLogRow[];
  deltaEnv: "testnet" | "production";
  maxLeverage: number;
  confirmPhrase: string;
  paused: boolean;
  lastCycle: Partial<Record<Instrument, CycleSummary>>;
  candles: Partial<Record<Instrument, Candle[]>>;
  agents: Record<AgentName, AgentLive>;
  ticker: AgentResult[];
  toasts: Toast[];
  backtestProgress: number;
  journalTick: number;
  // actions
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void;
  setView: (v: ViewId) => void;
  toggle: (k: "beginner" | "sound" | "force2D") => void;
  pushToast: (t: Omit<Toast, "id">) => void;
  dropToast: (id: number) => void;
  onAgent: (r: AgentResult) => void;
  appendCandle: (i: Instrument, c: Candle) => void;
}

const AGENT_NAMES: AgentName[] = ["Scout", "Cartographer", "Hunter", "Analyst", "Guardian", "Executioner", "Chronicler"];
const emptyAgents = () =>
  Object.fromEntries(AGENT_NAMES.map((n) => [n, { history: [], pulse: 0, vetoAt: 0 } as AgentLive])) as Record<AgentName, AgentLive>;

let toastId = 1;

export const useStore = create<State>((set, get) => ({
  view: "overview",
  beginner: persisted("qp_beginner", true),
  sound: persisted("qp_sound", false),
  force2D: persisted("qp_force2d", false),
  paletteOpen: false,
  wsConnected: false,
  loaded: false,
  selectedAgent: null,
  instrument: "BTCUSD",
  confettiKey: 0,
  deltaPulse: 0,
  tourOpen: false,
  mode: "DEMO",
  dataSource: "demo",
  execution: "paper",
  banner: null,
  analystMode: "rules",
  model: "",
  instruments: [],
  digits: {},
  kpis: null,
  positions: [],
  equity: [],
  session: null,
  rules: null,
  params: null,
  delta: null,
  account: null,
  quotes: {},
  execLog: [],
  deltaEnv: "testnet",
  maxLeverage: 25,
  confirmPhrase: "I UNDERSTAND THE RISK",
  paused: false,
  lastCycle: {},
  candles: {},
  agents: emptyAgents(),
  ticker: [],
  toasts: [],
  backtestProgress: 0,
  journalTick: 0,

  set: (p) => set(p),
  setView: (v) => set({ view: v, paletteOpen: false }),
  toggle: (k) => {
    const next = !get()[k];
    store?.setItem(k === "beginner" ? "qp_beginner" : k === "sound" ? "qp_sound" : "qp_force2d", next ? "1" : "0");
    set({ [k]: next });
  },
  pushToast: (t) => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
    window.setTimeout(() => get().dropToast(id), t.level === "error" ? 9000 : 5500);
  },
  dropToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  onAgent: (r) =>
    set((s) => {
      const cur = s.agents[r.agent] ?? { history: [], pulse: 0, vetoAt: 0 };
      const live: AgentLive = {
        last: r,
        history: [r, ...cur.history].slice(0, 25),
        pulse: cur.pulse + 1,
        vetoAt: r.status === "veto" ? Date.now() : cur.vetoAt
      };
      const interesting = r.status !== "skip" || r.agent === "Hunter";
      return {
        agents: { ...s.agents, [r.agent]: live },
        ticker: interesting ? [r, ...s.ticker].slice(0, 40) : s.ticker
      };
    }),
  appendCandle: (i, c) =>
    set((s) => {
      const arr = s.candles[i];
      if (!arr) return { candles: { ...s.candles, [i]: [c] } };
      const last = arr[arr.length - 1];
      if (last && c.time < last.time) return {};
      const next = last && last.time === c.time ? [...arr.slice(0, -1), c] : [...arr, c];
      return { candles: { ...s.candles, [i]: next.slice(-800) } };
    })
}));
