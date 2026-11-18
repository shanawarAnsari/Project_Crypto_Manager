/** Desk orchestrator: owns all services and runs the 7-agent pipeline on every 5M candle close. */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { DeltaMarketStream, type StreamCandle, type StreamTicker } from "../exchange/market-stream.js";
import { Analyst, OpenAiCompatibleModel } from "./analyst.js";
import { buildDailyReview, createAgents, newContext, PIPELINE_ORDER, type Agent, type CycleContext, type DeskServices } from "./agents.js";
import type { DeskConfig } from "./config.js";
import { DeskDatabase } from "./db.js";
import { DeltaBridge, type DeltaFill, type DeltaHealth, type DeltaPosition, type OrderResult } from "./delta-bridge.js";
import { DemoFeed } from "./demo-feed.js";
import { roundTo, sessionInfo, specFor } from "./market.js";
import { PaperEngine, round2, type PositionEvent } from "./paper-engine.js";
import { DEFAULT_RULES, mergeRules, newGuardianState, type GuardianState, type RiskRules } from "./risk.js";
import { DEFAULT_PARAMS, mapLiquidity, mergeParams, type StrategyParams } from "./strategy.js";
import type { Bar, CycleSummary, DataSource, ExecutionVenue, Position, Toast } from "./types.js";

/** Broadcasts `{type, data, ts}` frames to every connected WebSocket client. */
export class EventHub {
  readonly clients = new Set<WebSocket>();
  sent = 0;
  emit(type: string, data: unknown): void {
    const frame = JSON.stringify({ type, data, ts: Date.now() / 1000 });
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        ws.send(frame);
        this.sent += 1;
      }
    }
  }
}

/** Desk-owned Delta position state used for break-even, partial and trailing management. */
export interface ManagedPosition {
  id: string;
  signal_id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entry: number;
  initial_stop: number;
  stop: number;
  tp1: number;
  tp2: number;
  contracts: number;
  initial_contracts: number;
  realized: number;
  tp1_hit: boolean;
  breakeven: boolean;
  opened_at: number;
  last_mark: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Desk implements DeskServices {
  params: StrategyParams;
  rules: RiskRules;
  readonly guardian: GuardianState = newGuardianState();
  readonly analyst: Analyst;
  readonly paper: PaperEngine;
  readonly db: DeskDatabase;
  readonly delta: DeltaBridge;
  readonly feed: DemoFeed;
  readonly agents: Agent[] = createAgents();
  dataSource: DataSource = "demo";
  execution: ExecutionVenue = "paper";
  paused = false;
  scenarioUntil = 0;
  banner: string | null = null;
  cycles = 0;
  tradesTaken = 0;
  readonly lastCycle: Record<string, CycleSummary> = {};
  private readonly liveBars: Record<string, Bar[]> = {};
  private readonly deltaEquityCurve: Array<{ time: number; equity: number }> = [];
  private readonly spreads: Record<string, number> = {};
  private readonly lastSeenBar: Record<string, number> = {};
  private readonly formingBars: Record<string, Bar> = {};
  readonly quotes: Record<string, { mark: number; updated_at: number }> = {};
  private readonly stream: DeltaMarketStream;
  private historyNeedsRefresh = false;
  accountUpdatedAt: number | null = null;
  accountError: string | null = null;
  deltaPositions: DeltaPosition[] = [];
  deltaWallet: { balance: number; available: number; asset: string } | null = null;
  deltaFills: DeltaFill[] = [];
  private fillsFetchedAt = 0;
  managed: Record<string, ManagedPosition>;
  private running = false;
  private readonly timers: NodeJS.Timeout[] = [];
  private deltaWasOk: boolean | null = null;
  private managing = false;

  constructor(readonly cfg: DeskConfig, readonly hub: EventHub, deps: { fetcher?: typeof fetch; db?: DeskDatabase; feed?: DemoFeed; stream?: DeltaMarketStream } = {}) {
    this.db = deps.db ?? new DeskDatabase(cfg.databasePath);
    this.rules = mergeRules({ ...DEFAULT_RULES, allowed_sessions: [...DEFAULT_RULES.allowed_sessions], news_hours_utc: [] }, this.db.kvGet("rules", {}));
    this.rules.leverage = Math.min(this.rules.leverage, cfg.maxLeverage);
    this.params = mergeParams({ ...DEFAULT_PARAMS }, this.db.kvGet("params", {}));
    this.managed = this.db.kvGet("managed", {});
    this.paper = new PaperEngine(cfg.startingBalance);
    this.feed = deps.feed ?? new DemoFeed(cfg.instruments);
    for (const s of cfg.instruments) specFor(s);
    const model = cfg.analystApiKey ? new OpenAiCompatibleModel(cfg.analystApiKey, cfg.analystBaseUrl, cfg.analystModel, cfg.analystTimeoutMs) : null;
    this.analyst = new Analyst(model, cfg.analystModel);
    this.execution = cfg.execution;
    this.delta = new DeltaBridge(
      { apiKey: cfg.deltaApiKey, apiSecret: cfg.deltaApiSecret, environment: cfg.deltaEnvironment, liveTradingConfirmed: cfg.liveTradingConfirmed },
      (row) => {
        this.db.logExec(row);
        this.hub.emit("delta_log", row);
      },
      deps.fetcher ?? fetch
    );
    this.dataSource = cfg.demoMode ? "demo" : "delta";
    this.stream = deps.stream ?? new DeltaMarketStream({ environment: cfg.deltaEnvironment, symbols: cfg.instruments, timeframes: ["5m"] });
    this.stream.on("candle", (update: StreamCandle) => {
      if (this.dataSource !== "delta" || update.timeframe !== "5m") return;
      const c = update.candle;
      const bar: Bar = { time: c.timestamp / 1000, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) };
      const closed = this.liveBars[update.symbol]?.at(-1)?.time ?? 0;
      if (bar.time <= closed || bar.time < (this.formingBars[update.symbol]?.time ?? 0)) return;
      this.formingBars[update.symbol] = bar;
      this.broadcastMarket({ [update.symbol]: bar });
    });
    this.stream.on("ticker", (tick: StreamTicker) => {
      if (this.dataSource !== "delta") return;
      this.quotes[tick.symbol] = { mark: Number(tick.markPrice), updated_at: tick.receivedAt / 1000 };
      this.broadcastMarket({});
    });
    this.stream.on("streamError", (message: string) => {
      process.stderr.write(`${message}; REST polling remains active.\n`);
    });
    this.stream.on("connected", () => { this.historyNeedsRefresh = true; });
  }

  // ---------------------------------------------------------------- DeskServices
  clock(): number {
    return this.dataSource === "demo" ? this.feed.clock() : Math.floor(Date.now() / 1000);
  }

  bars(instrument: string, n: number): Bar[] {
    return this.dataSource === "demo" ? this.feed.candles(instrument, n) : (this.liveBars[instrument] ?? []).slice(-n);
  }

  chartBars(instrument: string, n: number): Bar[] {
    const closed = this.bars(instrument, n);
    const forming = this.dataSource === "delta" ? this.formingBars[instrument] : undefined;
    return forming && forming.time > (closed.at(-1)?.time ?? 0) ? [...closed, forming].slice(-n) : closed;
  }

  async spreadPct(instrument: string): Promise<number> {
    if (this.dataSource === "demo") return this.feed.spreadPct(instrument);
    return this.spreads[instrument] ?? 0;
  }

  equity(): number {
    if (this.execution === "delta") {
      return this.deltaWallet ? round2(this.deltaWallet.balance + this.deltaPositions.reduce((s, p) => s + p.unrealizedPnl, 0)) : 0;
    }
    return this.paper.equity();
  }

  balance(): number {
    return this.execution === "delta" ? round2(this.deltaWallet?.balance ?? 0) : round2(this.paper.balance);
  }

  availableMargin(): number {
    if (this.execution === "delta") return this.deltaWallet?.available ?? 0;
    return Math.max(0, this.paper.equity() - this.paper.usedMargin(this.rules.leverage));
  }

  openTradeCount(): number {
    return this.execution === "delta" ? this.deltaPositions.length : this.paper.positions.size;
  }

  hasPosition(instrument: string): boolean {
    return this.execution === "delta" ? this.deltaPositions.some((p) => p.symbol === instrument) : this.paper.openPositions(instrument).length > 0;
  }

  lastPrice(instrument: string): number {
    return this.bars(instrument, 1).at(-1)?.close ?? 0;
  }

  toast(t: Toast): void {
    this.hub.emit("toast", t);
  }

  async sendDeltaOrder(ctx: CycleContext): Promise<OrderResult> {
    if (this.accountError || !this.accountUpdatedAt || Date.now() / 1000 - this.accountUpdatedAt > 15) {
      return { ok: false, message: "Delta account data is unavailable or stale; order refused.", symbol: ctx.instrument };
    }
    const quote = this.quotes[ctx.instrument];
    if (this.dataSource !== "delta" || !quote || Date.now() / 1000 - quote.updated_at > 15) {
      return { ok: false, message: "Delta market data is unavailable or stale; order refused.", symbol: ctx.instrument };
    }
    const setup = ctx.setup!;
    const plan = ctx.decision!.trade_plan;
    if (!this.db.claimSignal(setup.signal_id, { symbol: ctx.instrument, direction: setup.direction, contracts: ctx.contracts, plan })) {
      return { ok: false, duplicate: true, message: "Signal already executed once (idempotency guard).", symbol: ctx.instrument };
    }
    const res = await this.delta.placeEntry({
      signalId: setup.signal_id, symbol: ctx.instrument, direction: setup.direction, contracts: ctx.contracts,
      stop: plan.stop_loss, target: plan.take_profit_2, leverage: this.rules.leverage
    });
    this.db.finishSignal(setup.signal_id, res.ok ? "filled" : "failed", res.message, res.orderId != null ? String(res.orderId) : null, res.price ?? null);
    if (res.ok) {
      const entry = res.price ?? plan.entry_price;
      this.managed[ctx.instrument] = {
        id: res.clientOrderId ?? randomUUID(), signal_id: setup.signal_id, symbol: ctx.instrument, direction: setup.direction, entry,
        initial_stop: plan.stop_loss, stop: plan.stop_loss, tp1: plan.take_profit_1, tp2: plan.take_profit_2,
        contracts: res.contracts ?? ctx.contracts, initial_contracts: res.contracts ?? ctx.contracts, realized: 0,
        tp1_hit: false, breakeven: false, opened_at: Date.now() / 1000, last_mark: entry
      };
      this.db.kvSet("managed", this.managed);
      void this.syncDelta();
    }
    return res;
  }

  onTradePlaced(ctx: CycleContext, venue: ExecutionVenue, price: number, contracts: number): void {
    this.tradesTaken += 1;
    const setup = ctx.setup!;
    this.hub.emit("trade_placed", { venue, price, volume: contracts, instrument: ctx.instrument, direction: setup.direction, signal_id: setup.signal_id, first: this.tradesTaken === 1 });
    this.toast({ level: "success", title: venue === "delta" ? `Trade placed on Delta India (${this.delta.accountLabel()})` : "Paper trade opened", message: `${setup.direction} ${contracts} contracts ${ctx.instrument} @ ${price}` });
  }

  // ---------------------------------------------------------------- views
  modeLabel(): string {
    if (this.execution === "delta") return this.delta.accountLabel() === "DEMO" ? "DELTA DEMO" : "DELTA LIVE";
    return this.dataSource === "delta" ? "PAPER" : "DEMO";
  }

  kpis(): Record<string, unknown> {
    const eq = this.equity();
    const start = this.guardian.day_start_equity || eq;
    const trades = this.db.trades(500, this.execution);
    const wins = trades.filter((t) => (t.pnl || 0) > 0).length;
    const openRisk = this.execution === "paper" ? this.paper.openRisk() : this.deltaOpenRisk();
    return {
      equity: eq, balance: this.balance(), today_pnl: round2(eq - start), today_pnl_pct: start ? Math.round((eq - start) / start * 100_000) / 1000 : 0,
      win_rate: trades.length ? Math.round(wins / trades.length * 1000) / 10 : 0, trades: trades.length,
      open_risk: openRisk, open_risk_pct: openRisk === null || !eq ? null : round2(openRisk / eq * 100),
      drawdown_pct: start ? Math.round(Math.max(0, (start - eq) / start * 100) * 1000) / 1000 : 0,
      dd_limit_pct: this.rules.daily_drawdown_kill_pct, kill_switch: this.guardian.kill_switch
    };
  }

  private deltaOpenRisk(): number | null {
    if (!this.deltaWallet || this.accountError || !this.accountUpdatedAt || Date.now() / 1000 - this.accountUpdatedAt > 15) return null;
    let total = 0;
    for (const position of this.deltaPositions) {
      const managed = this.managed[position.symbol];
      if (!managed || managed.direction !== position.direction || !Number.isFinite(managed.stop) || managed.stop <= 0) return null;
      const loss = position.direction === "LONG" ? position.entryPrice - managed.stop : managed.stop - position.entryPrice;
      total += Math.max(0, loss) * position.contracts * specFor(position.symbol).contractValue;
    }
    return round2(total);
  }

  positions(venue: ExecutionVenue = this.execution): Position[] {
    if (venue !== "delta") return this.paper.openPositions();
    return this.deltaPositions.map((p) => {
      const m = this.managed[p.symbol];
      return {
        id: m?.id ?? `${p.symbol}-manual`, signal_id: m?.signal_id ?? "manual", instrument: p.symbol, direction: p.direction,
        volume: p.contracts, initial_volume: m?.initial_contracts ?? p.contracts, entry_price: p.entryPrice, stop_loss: m?.stop ?? 0,
        initial_stop: m?.initial_stop ?? 0, take_profit_1: m?.tp1 ?? 0, take_profit_2: m?.tp2 ?? 0, opened_at: m?.opened_at ?? 0,
        status: "open", closed_at: null, exit_price: null, realized_pnl: m?.realized ?? 0, unrealized_pnl: round2(p.unrealizedPnl),
        tp1_hit: m?.tp1_hit ?? false, breakeven: m?.breakeven ?? false, venue: "delta", close_reason: m ? null : "Not managed by the desk"
      };
    });
  }

  snapshot(): Record<string, unknown> {
    return {
      mode: this.modeLabel(), data_source: this.dataSource, execution: this.execution, banner: this.banner,
      analyst_mode: this.analyst.mode, model: this.analyst.modelName, instruments: this.cfg.instruments, pipeline: PIPELINE_ORDER,
      kpis: this.kpis(), positions: this.positions(),
      equity_curve: (this.execution === "delta" ? this.deltaEquityCurve : this.paper.equityCurve).slice(-600), last_cycle: this.lastCycle,
      session: sessionInfo(this.clock()), rules: this.rules, params: this.params, delta: this.delta.lastHealth,
      delta_env: this.cfg.deltaEnvironment, max_leverage: this.cfg.maxLeverage, kill_switch: this.guardian.kill_switch, paused: this.paused,
      specs: Object.fromEntries(this.cfg.instruments.map((s) => [s, specFor(s)])),
      account: this.accountSnapshot(), quotes: this.quotes
    };
  }

  accountSnapshot(): Record<string, unknown> {
    const wallet = this.deltaWallet;
    return {
      environment: this.cfg.deltaEnvironment, wallet,
      equity: wallet ? round2(wallet.balance + this.deltaPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0)) : null,
      positions: this.positions("delta"), fills: this.deltaFills, updated_at: this.accountUpdatedAt, error: this.accountError
    };
  }

  private recordDeltaEquityPoint(time: number): { time: number; equity: number } | undefined {
    if (!this.deltaWallet || this.accountError) return undefined;
    const point = { time, equity: this.equity() };
    const last = this.deltaEquityCurve.at(-1);
    if (last && point.time <= last.time) return undefined;
    this.deltaEquityCurve.push(point);
    if (this.deltaEquityCurve.length > 600) this.deltaEquityCurve.splice(0, this.deltaEquityCurve.length - 600);
    return point;
  }

  // ---------------------------------------------------------------- lifecycle
  async start(): Promise<void> {
    this.running = true;
    await this.refreshHealth();
    if (!this.cfg.demoMode) {
      try {
        await this.loadLiveHistory();
      } catch (err) {
        this.banner = `Delta India market data unavailable: ${err instanceof Error ? err.message : String(err)}. Retrying; no synthetic data substituted.`;
      }
      this.stream.connect();
    }
    await this.syncDelta();
    this.resetDay(true);
    void this.cycleLoop();
    this.timers.push(setInterval(() => void this.refreshHealth().catch((err: unknown) => {
      process.stderr.write(`Delta health error: ${String(err)}\n`);
    }), 15_000));
    this.timers.push(setInterval(() => void this.syncDelta(), 3_000));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stream.close();
    for (const t of this.timers) clearInterval(t);
  }

  private resetDay(force = false): void {
    const key = new Date(this.clock() * 1000).toISOString().slice(0, 10);
    if (force || key !== this.guardian.day_key) {
      const prev = this.guardian.day_key;
      this.guardian.day_key = key;
      this.guardian.day_start_equity = this.equity();
      if (prev && !force) void this.writeReview(prev);
    }
  }

  async writeReview(day: string): Promise<string> {
    const since = Date.now() / 1000 - 86_400;
    const text = await buildDailyReview(this.db.decisionsSince(since), this.db.tradesSince(since), this.analyst.chat);
    this.db.saveReview(day, text);
    this.hub.emit("review", { day, text });
    return text;
  }

  // ---------------------------------------------------------------- pipeline
  async runPipeline(instrument: string, paceMs = 0): Promise<CycleContext> {
    const ctx = newContext(instrument, randomUUID().slice(0, 8));
    this.hub.emit("cycle_start", { instrument, cycle_id: ctx.cycleId });
    for (const agent of this.agents) {
      if (ctx.halted && agent.name !== "Chronicler") continue;
      if (agent.name === "Chronicler" && !ctx.setup) break;
      const res = await agent.run(ctx, this);
      this.hub.emit("agent", { instrument, cycle_id: ctx.cycleId, ...res });
      if (paceMs && ctx.setup && agent.name !== "Chronicler") await sleep(paceMs);
    }
    const summary: CycleSummary = {
      instrument, cycle_id: ctx.cycleId, outcome: ctx.outcome, ts: Date.now() / 1000, setup: ctx.setup, decision: ctx.decision,
      checks: ctx.checks, levels: ctx.levels, trace: ctx.trace, execution: ctx.execution
    };
    const prev = this.lastCycle[instrument];
    if (ctx.setup || !prev) this.lastCycle[instrument] = summary;
    else prev.levels = summary.levels; // keep the last interesting setup but refresh levels
    this.hub.emit("cycle_end", summary);
    if (ctx.outcome === "vetoed") {
      const veto = ctx.trace.find((r) => r.status === "veto");
      this.toast({ level: "warning", title: `AEGIS veto · ${instrument}`, message: (veto?.summary ?? "Vetoed").slice(0, 180) });
    }
    return ctx;
  }

  private handlePaperEvents(instrument: string, events: PositionEvent[]): void {
    for (const ev of events) {
      if (ev.type === "sl" || ev.type === "stop" || ev.type === "tp2") this.db.recordTrade(ev.position);
      this.hub.emit("position_event", { instrument, ...ev });
      const title = { tp1: "TP1 hit · 50% closed", tp2: "TP2 hit · trade closed", be: "Stop moved to break-even", sl: "Stop loss hit", stop: ev.reason ?? "Stopped", manual: "Closed manually" }[ev.type];
      const level = ev.type === "tp1" || ev.type === "tp2" ? "success" : ev.type === "be" || ev.type === "stop" ? "info" : "error";
      this.toast({ level, title, message: `${ev.position.instrument} ${ev.position.direction} · realized $${ev.position.realized_pnl.toFixed(2)}` });
    }
  }

  private broadcastMarket(candles: Record<string, Bar>): void {
    const equityPoint = this.execution === "paper" ? { time: this.clock(), equity: this.equity() } : undefined;
    this.hub.emit("market", {
      candles, kpis: this.kpis(), positions: this.positions(), ...(equityPoint ? { equity_point: equityPoint } : {}),
      session: sessionInfo(this.clock()), mode: this.modeLabel(),
      account: this.accountSnapshot(), quotes: this.quotes, banner: this.banner
    });
  }

  private async cycleLoop(): Promise<void> {
    while (this.running) {
      try {
        if (this.paused) {
          await sleep(500);
          continue;
        }
        const scenario = Date.now() < this.scenarioUntil;
        if (this.dataSource === "demo") {
          const fresh = this.feed.advance();
          this.resetDay();
          for (const [inst, candle] of Object.entries(fresh)) this.handlePaperEvents(inst, this.paper.onCandle(inst, candle));
          this.broadcastMarket(fresh);
          for (const inst of this.cfg.instruments) await this.runPipeline(inst, 350);
          this.cycles += 1;
          await sleep(scenario ? 900 : this.cfg.demoCycleSeconds * 1000);
        } else {
          await this.deltaCycle();
          await sleep(5_000);
        }
      } catch (err) {
        process.stderr.write(`cycle loop error: ${err instanceof Error ? err.stack : String(err)}\n`);
        this.toast({ level: "error", title: "Cycle error", message: "An internal error occurred; the desk will retry automatically." });
        await sleep(3_000);
      }
    }
  }

  async loadLiveHistory(): Promise<void> {
    for (const inst of this.cfg.instruments) {
      await this.delta.loadProduct(inst);
      const bars = await this.delta.candles5m(inst, 2000);
      if (bars.length < 100) throw new Error(`Not enough Delta history for ${inst}`);
      this.liveBars[inst] = bars;
      // Treat the latest closed bar as unseen so the pipeline runs immediately after switching to live data.
      this.lastSeenBar[inst] ??= bars.at(-2)!.time;
      const ticker = await this.delta.ticker(inst);
      this.spreads[inst] = ticker.spreadPct;
      this.quotes[inst] = { mark: ticker.mark, updated_at: Date.now() / 1000 };
    }
    this.historyNeedsRefresh = false;
  }

  private async deltaCycle(): Promise<void> {
    const fresh: Record<string, Bar> = {};
    for (const inst of this.cfg.instruments) {
      try {
        if (this.historyNeedsRefresh || !this.liveBars[inst]?.length) await this.loadLiveHistory();
        const latest = await this.delta.candles5m(inst, 6);
        const t = await this.delta.ticker(inst);
        this.spreads[inst] = t.spreadPct;
        this.quotes[inst] = { mark: t.mark, updated_at: Date.now() / 1000 };
        const series = this.liveBars[inst] ?? [];
        for (const bar of latest) {
          const idx = series.findIndex((b) => b.time === bar.time);
          if (idx >= 0) series[idx] = bar;
          else if (!series.length || bar.time > series.at(-1)!.time) series.push(bar);
        }
        if (series.length > 3000) series.splice(0, series.length - 2500);
        this.liveBars[inst] = series;
        if (this.formingBars[inst] && this.formingBars[inst].time <= (series.at(-1)?.time ?? 0)) delete this.formingBars[inst];
        const last = series.at(-1);
        if (last && last.time > (this.lastSeenBar[inst] ?? 0)) {
          this.lastSeenBar[inst] = last.time;
          fresh[inst] = last;
        }
      } catch (err) {
        this.banner = `Delta data delayed for ${inst}: ${err instanceof Error ? err.message : String(err)}. Retrying; last received values may be stale.`;
      }
    }
    if (this.cfg.instruments.every((inst) => Date.now() / 1000 - (this.quotes[inst]?.updated_at ?? 0) < 15)) this.banner = null;
    this.resetDay();
    for (const [inst, candle] of Object.entries(fresh)) {
      if (this.execution === "paper") this.handlePaperEvents(inst, this.paper.onCandle(inst, candle));
    }
    const chart: Record<string, Bar> = {};
    for (const inst of this.cfg.instruments) {
      const last = this.chartBars(inst, 1).at(-1);
      if (last) chart[inst] = last;
    }
    this.broadcastMarket(chart);
    if (Object.keys(fresh).length) {
      for (const inst of Object.keys(fresh)) await this.runPipeline(inst, 0);
      this.cycles += 1;
    }
  }

  // ---------------------------------------------------------------- Delta health / sync / management
  async refreshHealth(): Promise<DeltaHealth> {
    const h = await this.delta.health(this.cfg.instruments);
    const ok = h.connected && h.issues.length === 0;
    if (this.deltaWasOk !== null && ok !== this.deltaWasOk) {
      if (ok) this.toast({ level: "success", title: "Delta India ready", message: `Connected to the ${this.delta.accountLabel()} account.` });
      else if (h.issues[0]) this.toast({ level: "error", title: "Delta check failed", message: h.issues[0].fix });
    }
    this.deltaWasOk = ok;
    this.hub.emit("delta_status", { ...h, mode: this.modeLabel() });
    return h;
  }

  async syncDelta(): Promise<void> {
    if (this.managing) return;
    if (!this.delta.hasCredentials) {
      this.accountError = "No complete credentials configured for the selected Delta account.";
      this.hub.emit("delta_sync", { account: this.accountSnapshot() });
      return;
    }
    this.managing = true;
    try {
      const [wallet, positions] = await Promise.all([this.delta.wallet(), this.delta.positions()]);
      this.deltaWallet = wallet;
      this.deltaPositions = positions;
      if (Date.now() - this.fillsFetchedAt > 15_000) {
        // Fill history is informational: a failure here must not mark wallet/positions stale.
        this.fillsFetchedAt = Date.now();
        this.deltaFills = await this.delta.fills(30).catch(() => this.deltaFills);
      }
      this.accountUpdatedAt = Date.now() / 1000;
      this.accountError = null;
      const equityPoint = this.execution === "delta" ? this.recordDeltaEquityPoint(this.accountUpdatedAt) : undefined;
      if (this.execution === "delta" && this.delta.isReady()) await this.managePositions();
      this.hub.emit("delta_sync", {
        positions: this.positions(), account: this.accountSnapshot(), ...(equityPoint ? { equity_point: equityPoint } : {})
      });
    } catch (err) {
      this.accountError = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Delta account sync failed: ${this.accountError}\n`);
      this.hub.emit("delta_sync", { account: this.accountSnapshot() });
    } finally {
      this.managing = false;
    }
  }

  /** Break-even at 1R, 50% partial at TP1 and a trailing stop toward TP2 on the exchange position. */
  private async managePositions(): Promise<void> {
    let changed = false;
    for (const m of Object.values(this.managed)) {
      const pos = this.deltaPositions.find((p) => p.symbol === m.symbol);
      const cv = specFor(m.symbol).contractValue;
      const sign = m.direction === "LONG" ? 1 : -1;
      if (!pos) {
        // Closed on the exchange (bracket stop/target or manual). Estimate the exit from the last mark.
        const mark = m.last_mark;
        const stopHit = sign * (mark - m.stop) <= 0;
        const exit = stopHit ? m.stop : sign * (mark - m.tp2) >= 0 ? m.tp2 : mark;
        const pnl = round2(m.realized + (exit - m.entry) * sign * m.contracts * cv);
        const reason = stopHit ? (m.tp1_hit ? "Trailing stop" : m.breakeven ? "Break-even stop" : "Stop loss") : exit === m.tp2 ? "TP2" : "Closed on exchange";
        const p: Position = {
          id: m.id, signal_id: m.signal_id, instrument: m.symbol, direction: m.direction, volume: 0, initial_volume: m.initial_contracts,
          entry_price: m.entry, stop_loss: m.stop, initial_stop: m.initial_stop, take_profit_1: m.tp1, take_profit_2: m.tp2, opened_at: m.opened_at,
          status: "closed", closed_at: Date.now() / 1000, exit_price: roundTo(exit, specFor(m.symbol).digits), realized_pnl: pnl, unrealized_pnl: 0,
          tp1_hit: m.tp1_hit, breakeven: m.breakeven, venue: "delta", close_reason: reason
        };
        this.db.recordTrade(p);
        delete this.managed[m.symbol];
        changed = true;
        const type = reason === "TP2" ? "tp2" : reason === "Stop loss" ? "sl" : "stop";
        this.hub.emit("position_event", { instrument: m.symbol, type, position: p, reason });
        this.toast({ level: pnl >= 0 ? "success" : "error", title: `Delta position closed · ${reason}`, message: `${m.symbol} ${m.direction} · ≈ $${pnl.toFixed(2)}` });
        continue;
      }
      const mark = pos.markPrice || m.last_mark;
      m.last_mark = mark;
      m.contracts = pos.contracts;
      const r = Math.abs(m.entry - m.initial_stop);
      const reached = (lvl: number) => sign * (mark - lvl) >= 0;
      if (!m.breakeven && reached(m.entry + sign * r)) {
        if (await this.delta.updateStop(m.symbol, m.direction, m.entry, m.tp2)) {
          m.stop = m.entry;
          m.breakeven = true;
          changed = true;
          this.toast({ level: "info", title: "Delta stop moved to break-even", message: `${m.symbol} ${m.direction}` });
        }
      }
      if (!m.tp1_hit && reached(m.tp1)) {
        const half = Math.floor(m.contracts / 2);
        m.tp1_hit = true;
        changed = true;
        if (half >= 1 && half < m.contracts) {
          const res = await this.delta.reduce(m.symbol, m.direction, half, `${m.signal_id}:tp1`, "TP1 partial");
          if (res.ok) {
            m.realized = round2(m.realized + ((res.price ?? mark) - m.entry) * sign * half * cv);
            m.contracts -= half;
          }
        }
        if (!m.breakeven && (await this.delta.updateStop(m.symbol, m.direction, m.entry, m.tp2))) {
          m.stop = m.entry;
          m.breakeven = true;
        }
        this.hub.emit("position_event", { instrument: m.symbol, type: "tp1", position: this.positions().find((p) => p.instrument === m.symbol) });
        this.toast({ level: "success", title: "TP1 · 50% closed on Delta", message: `${m.symbol} ${m.direction}` });
      }
      if (m.tp1_hit) {
        const trail = mark - sign * r;
        if (sign * (trail - m.stop) >= 0.25 * r && (await this.delta.updateStop(m.symbol, m.direction, trail, m.tp2))) {
          m.stop = roundTo(trail, specFor(m.symbol).digits);
          changed = true;
        }
      }
    }
    if (changed) this.db.kvSet("managed", this.managed);
  }

  // ---------------------------------------------------------------- actions
  emitMode(): void {
    this.hub.emit("mode", { mode: this.modeLabel(), data_source: this.dataSource, execution: this.execution, banner: this.banner });
  }

  async setMode(body: { data_source?: string; execution?: string }): Promise<{ ok: boolean; message?: string }> {
    if (body.execution === "delta") {
      await this.refreshHealth();
      if (!this.delta.isReady()) return { ok: false, message: `Delta execution unavailable. ${this.delta.lastHealth.issues[0]?.fix ?? "Configure Delta first."}` };
      if (this.dataSource !== "delta") {
        try {
          await this.loadLiveHistory();
        } catch (err) {
          return { ok: false, message: `Could not load Delta market data: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      this.execution = "delta";
      this.dataSource = "delta";
      await this.syncDelta();
    } else if (body.execution === "paper") {
      this.execution = "paper";
    }
    if (body.data_source === "demo") {
      if (this.execution === "delta") return { ok: false, message: "Delta execution needs Delta market data. Switch execution to Paper first." };
      this.dataSource = "demo";
    } else if (body.data_source === "delta" && this.dataSource !== "delta") {
      try {
        await this.loadLiveHistory();
        this.dataSource = "delta";
      } catch (err) {
        return { ok: false, message: `Delta India market data unavailable: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    this.banner = null;
    if (this.dataSource === "delta") this.stream.connect();
    for (const k of Object.keys(this.lastCycle)) delete this.lastCycle[k];
    this.guardian.day_start_equity = this.equity();
    this.emitMode();
    return { ok: true };
  }

  updateSettings(rules: RiskRules, params: StrategyParams): void {
    this.rules = rules;
    this.params = params;
    this.db.kvSet("rules", rules);
    this.db.kvSet("params", params);
    this.hub.emit("settings", { rules, params });
  }

  runDemoScenario(instrument?: string): Record<string, unknown> {
    if (this.dataSource !== "demo") return { ok: false, message: "Demo scenarios run in Demo mode only." };
    const inst = instrument && this.cfg.instruments.includes(instrument) ? instrument : this.cfg.instruments[0]!;
    const market = this.feed.markets[inst]!;
    if (market.plan) return { ok: false, message: "A sweep is already playing out. Watch the chart!" };
    const levels = mapLiquidity(market.candles.slice(-900), this.params);
    const plan = market.forceScenario(levels);
    if (!plan) return { ok: false, message: "No suitable liquidity level near price right now; try again shortly." };
    // make sure the planted level is not on cooldown from earlier demo signals
    for (const key of [...this.guardian.recent_signals.keys()]) if (key.startsWith(inst)) this.guardian.recent_signals.delete(key);
    this.scenarioUntil = Date.now() + 40_000;
    this.toast({ level: "info", title: "Demo scenario armed", message: `${inst}: price will hunt the ${plan.side} at ${plan.level}.` });
    return { ok: true, instrument: inst, ...plan };
  }

  async engageKillSwitch(engaged: boolean, closeAll: boolean): Promise<Record<string, unknown>> {
    this.guardian.kill_switch = engaged;
    const closed: string[] = [];
    if (engaged && closeAll) {
      const prices = Object.fromEntries(this.cfg.instruments.map((s) => [s, this.lastPrice(s)]));
      for (const p of this.paper.closeAll(prices, "Kill switch", this.clock())) {
        this.db.recordTrade(p);
        closed.push(p.id);
      }
      if (this.delta.lastHealth.authenticated) {
        for (const p of await this.delta.positions(this.cfg.instruments).catch(() => [])) {
          const res = await this.delta.closePosition(p.symbol, "Kill switch");
          if (res.ok) closed.push(p.symbol);
        }
        await this.syncDelta();
      }
    }
    this.hub.emit("kill_switch", { engaged, closed });
    this.toast(engaged
      ? { level: "error", title: "KILL SWITCH ENGAGED", message: `New orders blocked.${closed.length ? ` Closed ${closed.length} position(s).` : ""}` }
      : { level: "success", title: "Kill switch released", message: "AEGIS will accept new signals again." });
    return { ok: true, engaged, closed };
  }

  closePaper(id: string): Record<string, unknown> {
    const pos = this.paper.positions.get(id);
    if (!pos) return { ok: false, message: "Position not found (it may have just closed)." };
    this.paper.close(pos, this.lastPrice(pos.instrument), "Manual close", this.clock());
    this.db.recordTrade(pos);
    this.hub.emit("position_event", { instrument: pos.instrument, type: "manual", position: pos });
    return { ok: true, position: pos };
  }

  async closeDelta(symbol: string): Promise<OrderResult> {
    const m = this.managed[symbol];
    if (m) {
      const pos = this.deltaPositions.find((p) => p.symbol === symbol);
      if (pos) m.last_mark = pos.markPrice;
    }
    const res = await this.delta.closePosition(symbol, "Manual close");
    await this.syncDelta();
    return res;
  }

  /** Places the minimum size on the Delta Demo account, then closes it, so it appears in Delta's order history. */
  async sendTestOrder(symbol: string): Promise<OrderResult> {
    if (this.cfg.deltaEnvironment !== "testnet") return { ok: false, message: "Test orders are only allowed on the Delta Demo account.", symbol };
    if (!this.delta.isReady()) return { ok: false, message: this.delta.lastHealth.issues[0]?.fix ?? "Delta is not ready.", symbol };
    if (this.deltaPositions.some((p) => p.symbol === symbol)) return { ok: false, message: `${symbol} already has an open position; test skipped.`, symbol };
    const t = await this.delta.ticker(symbol);
    const signalId = `TEST-${symbol}-${Date.now()}`;
    this.db.claimSignal(signalId, { test: true });
    const res = await this.delta.placeEntry({ signalId, symbol, direction: "LONG", contracts: 1, stop: t.mark * 0.98, target: t.mark * 1.02, leverage: 1 });
    this.db.finishSignal(signalId, res.ok ? "filled" : "failed", res.message, res.orderId != null ? String(res.orderId) : null, res.price ?? null);
    if (!res.ok) return res;
    await sleep(3_000);
    const close = await this.delta.closePosition(symbol, "Test order close");
    return { ...res, ok: close.ok, message: close.ok ? `Test order filled @ ${res.price} and closed.` : `Test order filled but close failed: ${close.message}` };
  }
}
