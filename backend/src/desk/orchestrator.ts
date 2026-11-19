import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { DeltaMarketStream, type StreamCandle, type StreamTicker } from "../exchange/market-stream.js";
import { PIPELINE_ORDER } from "./agents.js";
import { evaluateCandidate, strategies } from "./catalog.js";
import { bracketPrices, budgetedLossPerContract } from "./candidate-policy.js";
import type { DeskConfig } from "./config.js";
import { DeskDatabase } from "./db.js";
import { DeltaBridge, type DeltaPosition, type DeltaFill } from "./delta-bridge.js";
import { FIVE_MIN, roundTo, sessionFor, sessionInfo, specFor } from "./market.js";
import { DEFAULT_RULES, mergeRules, newGuardianState, validateRules, type RiskRules } from "./risk.js";
import { DEFAULT_PARAMS, mergeParams, validateParams, type StrategyParams } from "./strategy.js";
import type { Bar, CycleSummary, Toast } from "./types.js";

const now = () => Date.now() / 1000;
const day = () => new Date().toISOString().slice(0, 10);
const fresh = (t: number | null, seconds = 15) => t !== null && now() >= t && now() - t <= seconds;
const latestClosed = () => (Math.floor(now() / FIVE_MIN) - 1) * FIVE_MIN;
const message = (err: unknown) => err instanceof Error ? err.message : "Delta unavailable";

export class EventHub {
  readonly clients = new Set<WebSocket>();
  sent = 0;
  emit(type: string, data: unknown): void {
    const frame = JSON.stringify({ type, data, ts: now() });
    for (const ws of this.clients) if (ws.readyState === 1) { ws.send(frame); this.sent++; }
  }
}

export class Desk {
  readonly dataSource = "delta";
  readonly analyst = { mode: "catalog", modelName: "Deterministic catalog" };
  readonly db: DeskDatabase;
  readonly delta: DeltaBridge;
  readonly guardian = newGuardianState();
  readonly lastCycle: Record<string, CycleSummary> = {};
  readonly quotes: Record<string, { mark: number; updated_at: number }> = {};
  private readonly stream: DeltaMarketStream;
  private readonly history: Record<string, Bar[]> = {};
  private readonly forming: Record<string, Bar> = {};
  private readonly seen: Record<string, number> = {};
  private readonly curve: { time: number; equity: number }[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private running = false;
  private polling = false;
  private generation = 0;
  private permit: (() => boolean) | null = null;
  private syncing: Promise<void> | null = null;
  private workingOrders: boolean | null = null;
  private selected: string | null = null;
  private armed = false;
  private armedAt = 0;
  private suspended = false;
  get execution(): "disabled" | "delta" { return this.armed ? "delta" : "disabled"; }
  get strategyId(): string | null { return this.selected; }
  get paused(): boolean { return this.suspended; }
  set paused(value: boolean) { if (value) this.disarm(); this.suspended = value; }
  banner: string | null = null;
  cycles = 0;
  deltaPositions: DeltaPosition[] = [];
  deltaFills: DeltaFill[] = [];
  fillsError: string | null = "Awaiting Delta demo fills";
  fillsUpdatedAt: number | null = null;
  deltaWallet: Awaited<ReturnType<DeltaBridge["wallet"]>> | null = null;
  accountUpdatedAt: number | null = null;
  accountError: string | null = "Awaiting Delta demo account";
  rules: RiskRules;
  params: StrategyParams;

  constructor(readonly cfg: DeskConfig, readonly hub: EventHub, deps: { fetcher?: typeof fetch; db?: DeskDatabase; stream?: DeltaMarketStream } = {}) {
    this.db = deps.db ?? new DeskDatabase(cfg.databasePath);
    this.rules = mergeRules({ ...DEFAULT_RULES, leverage: Math.min(DEFAULT_RULES.leverage, cfg.maxLeverage) }, this.db.kvGet("rules", {}));
    this.params = mergeParams({ ...DEFAULT_PARAMS }, this.db.kvGet("params", {}));
    this.guardian.kill_switch = this.db.kvGet("kill", false);
    this.delta = new DeltaBridge({
      apiKey: cfg.deltaApiKey, apiSecret: cfg.deltaApiSecret, environment: cfg.deltaEnvironment,
      maySubmit: () => this.permit?.() === true
    }, row => { this.db.logExec(row); this.hub.emit("delta_log", row); }, deps.fetcher);
    this.stream = deps.stream ?? new DeltaMarketStream({ environment: "testnet", symbols: cfg.instruments, timeframes: ["5m"] });
    this.stream.on("streamError", () => { /* REST remains authoritative for strategy bars and quotes. */ });
    this.stream.on("candle", (u: StreamCandle) => {
      if (!cfg.instruments.includes(u.symbol) || u.timeframe !== "5m") return;
      const c = u.candle;
      const b = { time: c.timestamp / 1000, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) };
      if (!Object.values(b).every(Number.isFinite) || b.time <= (this.history[u.symbol]?.at(-1)?.time ?? 0) || b.time < (this.forming[u.symbol]?.time ?? 0)) return;
      this.forming[u.symbol] = b;
      this.market({ [u.symbol]: b });
    });
    this.stream.on("ticker", (u: StreamTicker) => {
      const mark = Number(u.markPrice);
      if (!cfg.instruments.includes(u.symbol) || !Number.isFinite(mark) || mark <= 0) return;
      this.quotes[u.symbol] = { mark, updated_at: u.receivedAt / 1000 };
      this.market({});
    });
  }

  modeLabel(): string { return this.armed ? "DELTA DEMO · ARMED" : "DELTA DEMO · OBSERVE"; }
  toast(t: Toast) { this.hub.emit("toast", t); }
  bars(symbol: string, n: number) { return (this.history[symbol] ?? []).slice(-n); }
  chartBars(symbol: string, n: number) {
    const bars = this.bars(symbol, n), b = this.forming[symbol];
    return b && b.time > (bars.at(-1)?.time ?? 0) ? [...bars, b].slice(-n) : bars;
  }
  private equity() { return this.deltaWallet ? this.deltaWallet.balance + this.deltaPositions.reduce((s,p) => s + p.unrealizedPnl, 0) : null; }
  positions() {
    return this.deltaPositions.map(p => ({
      id: String(p.productId), instrument: p.symbol, direction: p.direction, volume: p.contracts, entry_price: p.entryPrice,
      unrealized_pnl: p.unrealizedPnl, mark_price: p.markPrice, status: "open", venue: "delta",
      stop_loss: null, take_profit_1: null, take_profit_2: null, opened_at: null, realized_pnl: null
    }));
  }
  accountSnapshot() {
    return { environment: "testnet", wallet: this.deltaWallet, equity: this.equity(), positions: this.positions(), fills: this.deltaFills,
      updated_at: this.accountUpdatedAt, error: this.accountError, working_orders: this.workingOrders,
      fills_error: this.fillsError, fills_updated_at: this.fillsUpdatedAt };
  }
  kpis() {
    const eq = this.equity(), start = this.guardian.day_key === day() ? this.guardian.day_start_equity : 0;
    const valid = eq !== null && !this.accountError && fresh(this.accountUpdatedAt);
    const diff = valid && start > 0 ? eq - start : null;
    const openRisk = valid && !this.workingOrders && this.deltaPositions.length === 0 ? 0 : null;
    return { equity: valid ? eq : null, balance: valid ? this.deltaWallet?.balance : null, today_pnl: diff,
      today_pnl_pct: diff !== null ? diff / start * 100 : null, drawdown_pct: diff !== null ? Math.max(0, -diff / start * 100) : null,
      win_rate: null, trades: null, open_risk: openRisk, open_risk_pct: openRisk, dd_limit_pct: this.rules.daily_drawdown_kill_pct,
      kill_switch: this.guardian.kill_switch };
  }
  snapshot() {
    return { mode: this.modeLabel(), data_source: this.dataSource, execution: this.execution, strategy_id: this.strategyId,
      execution_permitted: this.cfg.execution === "delta", banner: this.banner, analyst_mode: this.analyst.mode, model: this.analyst.modelName,
      instruments: this.cfg.instruments, pipeline: PIPELINE_ORDER, kpis: this.kpis(), positions: this.positions(), equity_curve: this.curve.slice(),
      last_cycle: this.lastCycle, session: sessionInfo(now()), rules: this.rules, params: this.params, delta: this.delta.lastHealth, delta_env: "testnet",
      max_leverage: this.cfg.maxLeverage, kill_switch: this.guardian.kill_switch, paused: this.paused,
      specs: Object.fromEntries(Object.keys(this.delta.lastHealth.products).map(s => [s,specFor(s)])),
      account: this.accountSnapshot(), quotes: this.quotes };
  }
  private market(candles: Record<string, Bar>) {
    this.hub.emit("market", { candles, kpis: this.kpis(), positions: this.positions(), session: sessionInfo(now()),
      mode: this.modeLabel(), account: this.accountSnapshot(), quotes: this.quotes, banner: this.banner });
  }
  private disarm() {
    this.generation++;
    this.permit = null;
    this.armed = false;
    this.hub.emit("mode", { mode: this.modeLabel(), execution: this.execution, data_source: "delta", strategy_id: this.strategyId });
  }
  selectStrategy(id: string) {
    if (!strategies.some(s => s.id === id)) return { ok: false, message: "Unknown catalog strategy" };
    this.selected = id;
    this.disarm();
    return { ok: true, message: "Strategy selected; execution disabled until armed." };
  }
  private accountBlock(requireFlat = true): string | null {
    if (this.accountError || !fresh(this.accountUpdatedAt) || !this.deltaWallet) return "Fresh authenticated account data required";
    if (!(this.deltaWallet.available > 0 && this.deltaWallet.balance > 0)) return "Positive demo balance and available margin required";
    const drawdown = this.kpis().drawdown_pct;
    if (drawdown === null || drawdown >= this.rules.daily_drawdown_kill_pct || this.db.kvGet(`dd-lock:${day()}`,false)) return "Session drawdown baseline unavailable or limit reached";
    if (requireFlat && (this.workingOrders !== false || this.deltaPositions.length)) return "Account must have no positions or working orders";
    return null;
  }
  private environmentBlock(requireFlat = true): string | null {
    if (this.cfg.execution !== "delta") return "Set DESK_EXECUTION=delta to permit demo execution";
    if (!this.selected) return "Select a catalog strategy first";
    if (this.paused || this.guardian.kill_switch) return "Desk paused or kill switch engaged";
    if (!this.delta.isReady()) return "Fresh healthy authenticated Delta demo connection required";
    if (validateRules(this.rules, this.cfg.maxLeverage).length) return "Invalid risk configuration";
    return this.accountBlock(requireFlat);
  }
  async setMode(b: { execution?: string; data_source?: string }) {
    this.disarm();
    if ((b.data_source && b.data_source !== "delta") || !["disabled","delta"].includes(b.execution ?? "")) return { ok: false, message: "Choose disabled or delta; synthetic data is unavailable" };
    if (b.execution === "disabled") return { ok: true, message: "Execution disabled" };
    if (this.cfg.execution !== "delta" || !this.selected || this.guardian.kill_switch || this.paused || this.db.hasUnresolvedOrder()) {
      return { ok: false, message: "Select a strategy, enable demo execution and resolve any risk or unknown-order lock first." };
    }
    const generation = this.generation;
    await this.refreshHealth();
    await this.syncDelta();
    const block = this.environmentBlock();
    if (generation !== this.generation || block) return { ok: false, message: block ?? "Arming interrupted" };
    this.armed = true;
    this.armedAt = now();
    this.hub.emit("mode", { mode: this.modeLabel(), execution: this.execution, data_source: "delta", strategy_id: this.selected });
    return { ok: true, message: "Autonomous demo scanning armed; at most one position will be open at a time." };
  }
  updateSettings(rules: RiskRules, params: StrategyParams) {
    const errors = [...validateRules(rules, this.cfg.maxLeverage), ...validateParams(params, rules.min_rr)];
    if (errors.length) throw new Error(errors.join("; "));
    this.disarm(); this.rules = rules; this.params = params;
    this.db.kvSet("rules", rules); this.db.kvSet("params", params);
    this.hub.emit("settings", { rules, params });
  }
  async engageKillSwitch(engaged: boolean, closeAll: boolean) {
    this.disarm();
    this.guardian.kill_switch = engaged;
    this.db.kvSet("kill", engaged); this.hub.emit("kill_switch", { engaged, closed: [] });
    return { ok: !closeAll, engaged, closed: [], message: closeAll ? "Switch applied; close positions directly on Delta demo." : "Execution disarmed" };
  }
  async closeDelta(_symbol: string) { return { ok: false, message: "Close directly on Delta demo. Desk does not modify existing positions." }; }
  async refreshHealth() {
    const h = await this.delta.health(this.cfg.instruments);
    if (this.armed && !this.delta.isReady()) this.disarm();
    this.hub.emit("delta_status", { ...h, mode: this.modeLabel() });
    return h;
  }
  async syncDelta() {
    this.syncing ??= this.readAccount().finally(() => { this.syncing = null; });
    return this.syncing;
  }
  private async readAccount() {
    const t = now();
    try {
      if (!this.delta.hasCredentials) throw new Error("Demo credentials not configured");
      const [wallet, positions, orders] = await Promise.all([this.delta.wallet(), this.delta.positions(), this.delta.hasWorkingOrders()]);
      if (!fresh(t)) throw new Error("Account response is stale");
      this.deltaWallet = wallet; this.deltaPositions = positions; this.workingOrders = orders;
      this.accountUpdatedAt = t; this.accountError = null;
      const eq = this.equity()!;
      if (eq > 0 && this.guardian.day_key !== day()) {
        this.guardian.day_key = day();
        const key = `day-start:${day()}`;
        this.guardian.day_start_equity = this.db.kvGet(key, eq);
        this.db.kvSet(key, this.guardian.day_start_equity);
      }
      const point = { time: t, equity: eq };
      if ((this.kpis().drawdown_pct ?? 0) >= this.rules.daily_drawdown_kill_pct) this.db.kvSet(`dd-lock:${day()}`,true);
      this.curve.push(point); if (this.curve.length > 600) this.curve.shift();
      this.hub.emit("delta_sync", { account: this.accountSnapshot(), positions: this.positions(), equity_point: point });
      if (this.armed && this.accountBlock(false)) this.disarm();
    } catch (e) {
      this.accountError = message(e);
      if (this.armed) this.disarm();
      this.hub.emit("delta_sync", { account: this.accountSnapshot() });
    }
  }
  private async readFills() {
    if (!this.delta.hasCredentials) return;
    try { this.deltaFills = await this.delta.fills(); this.fillsError = null; this.fillsUpdatedAt = now(); }
    catch (e) { this.fillsError = message(e); }
  }
  private async cycle(symbol: string, bars: Bar[]) {
    const id = this.selected, last = bars.at(-1)!;
    const generation = this.generation;
    const summary: CycleSummary = { instrument: symbol, cycle_id: randomUUID(), ts: now(), outcome: "none", setup: null, decision: null,
      checks: [], levels: [], trace: [], execution: {} };
    const note = (agent: string, status: "ok"|"skip"|"veto"|"error", text: string) => {
      const row = { agent, status, summary: text, data: { strategy_id: id }, confidence: 0, timestamp: now(), latency_ms: 0 };
      summary.trace.push(row); this.hub.emit("agent", { ...row, instrument: symbol, cycle_id: summary.cycle_id });
    };
    this.hub.emit("cycle_start", { instrument: symbol, cycle_id: summary.cycle_id });
    let signal: string | null = null;
    try {
      if (!id) { note("Candidate","skip","No catalog strategy selected"); return; }
      if (bars.length < 50 || last.time !== latestClosed() || !bars.slice(-50).every((b,i) => b.time === last.time - (49-i)*FIVE_MIN)) throw new Error("Stale or noncontiguous candle history");
      note("Market","ok","Fresh closed Delta 5m candles");
      const direction = evaluateCandidate(id, bars);
      if (!direction) { note("Candidate","skip","No signal on this closed candle"); return; }
      signal = `${id}:${symbol}:${last.time}`;
      note("Candidate","ok",`${id}: ${direction}`);
      if (!this.armed) { summary.outcome = "skipped"; note("Execution","skip","Observation only"); return; }
      if (last.time + FIVE_MIN < this.armedAt || !fresh(last.time + FIVE_MIN,30)) {
        summary.outcome = "skipped"; note("Execution","skip","Awaiting a new close after arming"); return;
      }
      await this.syncDelta();
      const t = now();
      const blocked = this.environmentBlock(false);
      if (!this.armed || generation !== this.generation || blocked) throw new Error(blocked ?? "No longer armed");
      if (this.deltaPositions.length || this.workingOrders !== false) {
        summary.outcome = "skipped";
        note("Execution", "skip", "Waiting for existing demo exposure or working orders to clear");
        return;
      }
      const [quote, product] = await Promise.all([this.delta.ticker(symbol), this.delta.loadProduct(symbol, true)]);
      const entryBlock = this.environmentBlock();
      if (!this.armed || generation !== this.generation || entryBlock) throw new Error(entryBlock ?? "No longer armed");
      if (!product.live || quote.spreadPct > this.rules.spread_limit_pct || !fresh(t) || last.time !== latestClosed()) throw new Error("Product, spread or price freshness check failed");
      if (this.rules.session_filter && !this.rules.allowed_sessions.includes(sessionFor(t))) throw new Error("Outside allowed session");
      if (this.rules.news_filter && this.rules.news_hours_utc.includes(new Date(t * 1000).getUTCHours())) throw new Error("Blocked news hour");
      if (now() - this.db.kvGet<number>(`last-entry:${symbol}`, 0) < this.rules.cooldown_minutes * 60) throw new Error("Instrument on cooldown");
      const spec = specFor(symbol), long = direction === "long";
      const limit = long ? quote.ask : quote.bid;
      const grid = (p: number, up: boolean) => roundTo((up ? Math.ceil(p / spec.tickSize) : Math.floor(p / spec.tickSize)) * spec.tickSize, spec.digits);
      const bracket = bracketPrices(limit, direction);
      const stop = grid(bracket.stop, long), target = grid(bracket.target, !long);
      const dist = (long ? 1 : -1) * (limit - stop);
      const rr = (long ? 1 : -1) * (target - limit) / dist;
      if (dist <= 0 || !Number.isFinite(rr) || rr + 1e-8 < this.rules.min_rr) throw new Error("Bracket fails minimum risk/reward after rounding");
      // Price gaps/fees can exceed planned stop risk. Limit exposure to available cash (no borrowed buying power).
      const riskBudget = this.equity()! * Math.min(this.rules.risk_per_trade_pct, this.rules.max_risk_per_trade_pct) / 100;
      const perContract = budgetedLossPerContract(limit, stop, spec.contractValue, product.feeBps, quote.spreadPct);
      const contracts = Math.floor(Math.min(spec.maxContracts, riskBudget / perContract,
        this.deltaWallet!.available * .95 / (spec.contractValue * limit)));
      if (!Number.isSafeInteger(contracts) || contracts < spec.minContracts) throw new Error("Insufficient risk budget or free collateral for one contract");
      const plan = { signalId: signal, symbol, direction: long ? "LONG" as const : "SHORT" as const, contracts, limit, stop, target };
      if (!this.db.claimSignal(signal, plan)) throw new Error("Duplicate signal or unresolved demo submission");
      note("Guardian","ok",`${contracts} contracts; planned stop loss including estimated costs ${roundTo(perContract * contracts,2)} USD`);
      this.permit = () => this.generation === generation && this.armed && !this.environmentBlock() && fresh(t) && fresh(quote.timestamp) && last.time === latestClosed();
      try {
        this.db.kvSet(`last-entry:${symbol}`, now());
        const result = await this.delta.placeEntry(plan);
        this.db.finishSignal(signal, result.ok ? "filled" : "unknown", result.message, result.orderId == null ? null : String(result.orderId), result.price ?? null);
        summary.outcome = result.ok ? "taken" : "error"; summary.execution = { venue: "delta", ...result };
        note("Execution", result.ok ? "ok" : "error", result.message);
        if (result.ok) this.hub.emit("trade_placed", { instrument: symbol, signal_id: signal, direction: plan.direction, volume: result.contracts, price: result.price, venue:"delta" });
        else this.disarm();
      } finally { this.permit = null; }
    } catch (err) {
      if (this.armed) this.disarm();
      summary.outcome = "vetoed"; note("Guardian","veto", message(err));
    } finally {
      if (signal) this.db.logDecision(symbol, signal, summary.outcome, summary.trace.at(-1)?.summary ?? "", summary.trace);
      this.lastCycle[symbol] = summary;
      this.hub.emit("cycle_end", summary);
      this.cycles++;
    }
  }
  async poll() {
    if (this.polling || !this.running) return;
    this.polling = true;
    try {
      for (const symbol of this.cfg.instruments) {
        const prev = this.history[symbol];
        const count = prev?.at(-1)?.time === latestClosed() || prev?.at(-1)?.time === latestClosed() - FIVE_MIN ? 6 : 600;
        const bars = await this.delta.candles5m(symbol, count);
        if (!bars.length || bars.at(-1)?.time !== latestClosed()) throw new Error(`Awaiting fresh Delta candles for ${symbol}`);
        const series = [...(prev ?? []).filter(b => b.time < bars[0]!.time), ...bars].slice(-2000);
        this.history[symbol] = series;
        const last = series.at(-1)!;
        this.market({ [symbol]: this.chartBars(symbol,1)[0]! });
        if (this.running && !this.paused && last.time !== this.seen[symbol]) { this.seen[symbol] = last.time; await this.cycle(symbol,series); }
      }
      this.banner = null;
    } catch (e) { this.banner = message(e); if (this.armed) this.disarm(); }
    finally { this.polling = false; }
  }
  async start() {
    if (this.running) return;
    this.running = true; this.stream.connect();
    await Promise.all([this.refreshHealth(), this.syncDelta(), this.readFills()]);
    if (!this.running) return;
    this.timers.push(setInterval(() => void this.refreshHealth(), 15_000), setInterval(() => void this.syncDelta(), 3000),
      setInterval(() => void this.readFills(), 15_000), setInterval(() => void this.poll(), 5000));
    await this.poll();
  }
  async stop() { this.running = false; this.disarm(); this.stream.close(); this.timers.splice(0).forEach(clearInterval); }
  async writeReview(key: string) {
    const rows = this.db.decisionsSince(Date.parse(`${key}T00:00:00Z`) / 1000);
    const text = `${rows.length} candidate decisions; ${rows.filter(r => r.outcome === "taken").length} confirmed demo entries. Closed-trade P/L is not reconciled.`;
    this.db.saveReview(key,text); return text;
  }
}
