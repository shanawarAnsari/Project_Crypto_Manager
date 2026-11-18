import { describe, expect, it, vi } from "vitest";
import { clampToCandidate, mockDecision, parseDecision } from "../src/desk/analyst.js";
import { newContext } from "../src/desk/agents.js";
import { loadDeskConfig } from "../src/desk/config.js";
import { DeskDatabase } from "../src/desk/db.js";
import { DeltaBridge } from "../src/desk/delta-bridge.js";
import { specFor } from "../src/desk/market.js";
import { Desk, EventHub } from "../src/desk/orchestrator.js";
import { DeltaMarketStream } from "../src/exchange/market-stream.js";
import { PaperEngine } from "../src/desk/paper-engine.js";
import { contractSize, DEFAULT_RULES, evaluate, newGuardianState, type EvaluateInput } from "../src/desk/risk.js";
import { DEFAULT_PARAMS, detectAt, mapLiquidity } from "../src/desk/strategy.js";
import type { Bar, LiquidityLevel, Position, Setup } from "../src/desk/types.js";

const T0 = 1_790_000_000 - (1_790_000_000 % 300);

/** 38 quiet bars around 100, then a sweep of 100.5 by `sweepHigh`, then a bearish displacement close back inside. */
function sweepSeries(sweepHigh: number): Bar[] {
  const bars: Bar[] = [];
  for (let k = 0; k < 38; k += 1) {
    const up = k % 2 === 0;
    bars.push({ time: T0 + k * 300, open: up ? 100 : 100.05, high: 100.1, low: 99.9, close: up ? 100.05 : 100, volume: 10 });
  }
  bars.push({ time: T0 + 38 * 300, open: 100.2, high: sweepHigh, low: 100.15, close: 100.3, volume: 40 });
  bars.push({ time: T0 + 39 * 300, open: 100.3, high: 100.35, low: 99.75, close: 99.8, volume: 30 });
  return bars;
}

const LEVEL: LiquidityLevel = { name: "PDH", price: 100.5, side: "high", strength: 2 };

describe("liquidity sweep strategy", () => {
  it("detects a buy-side sweep with displacement as a SHORT with SL beyond the wick and TP1 at 1:2", () => {
    const [setup] = detectAt(sweepSeries(100.701), 39, [LEVEL], "SOLUSD", DEFAULT_PARAMS);
    expect(setup).toBeDefined();
    expect(setup!.direction).toBe("SHORT");
    expect(setup!.sweep_extreme).toBe(100.701);
    expect(setup!.extension_depth).toBeCloseTo(0.2, 2);
    expect(setup!.stop_loss).toBeGreaterThan(setup!.sweep_extreme);
    expect((setup!.entry_price - setup!.take_profit_1) / (setup!.stop_loss - setup!.entry_price)).toBeCloseTo(2, 2);
    expect(setup!.volume_spike).toBe(true);
  });

  it("ignores sweeps outside the configured depth window", () => {
    expect(detectAt(sweepSeries(100.55), 39, [LEVEL], "SOLUSD", DEFAULT_PARAMS)).toEqual([]); // 0.05% too shallow
    expect(detectAt(sweepSeries(101.5), 39, [LEVEL], "SOLUSD", DEFAULT_PARAMS)).toEqual([]); // 1% too deep
  });

  it("maps the previous day's high and low", () => {
    const bars: Bar[] = [];
    const day = 86_400;
    const start = T0 - (T0 % day) - day;
    for (let t = start; t < start + day + 8 * 3600; t += 300) {
      const prevDay = t < start + day;
      bars.push({ time: t, open: 100, high: prevDay ? 101 : 100.4, low: prevDay ? 99 : 99.6, close: 100, volume: 1 });
    }
    const names = mapLiquidity(bars).map((l) => `${l.name}@${l.price}`).join(",");
    expect(names).toContain("PDH");
    expect(names).toContain("@101");
    expect(names).toContain("PDL");
  });
});

describe("AEGIS risk", () => {
  const spec = { ...specFor("SOLUSD"), contractValue: 1 };
  const base: EvaluateInput = {
    instrument: "SOLUSD", direction: "LONG", entry: 100, stop: 99, tp1: 102, confidence: 8, session: "LONDON", spreadPct: 0.01,
    equity: 10_000, availableMargin: 10_000, openTrades: 0, instrumentHasPosition: false, signalId: "s1", levelKey: "SOLUSD:PDL",
    candleHourUtc: 9, analystBias: "BULLISH_SWEEP_LONG", spec, now: 1000
  };
  const rules = { ...DEFAULT_RULES, allowed_sessions: [...DEFAULT_RULES.allowed_sessions], news_hours_utc: [] };

  it("sizes whole contracts to the risk budget", () => {
    expect(contractSize(10_000, 1, 100, 99, spec)).toEqual([100, 100]);
    expect(contractSize(10, 1, 100, 99, spec)).toEqual([0, 0]);
  });

  it("approves a clean plan and vetoes kill switch, poor RR and insufficient margin", () => {
    expect(evaluate(rules, newGuardianState(), base).checks.every((c) => c.passed)).toBe(true);
    const killed = { ...newGuardianState(), kill_switch: true };
    expect(evaluate(rules, killed, base).checks.find((c) => c.name === "Kill switch")!.passed).toBe(false);
    expect(evaluate(rules, newGuardianState(), { ...base, tp1: 101.5 }).checks.find((c) => c.name === "Risk:Reward")!.passed).toBe(false);
    expect(evaluate(rules, newGuardianState(), { ...base, availableMargin: 50 }).checks.find((c) => c.name === "Margin")!.passed).toBe(false);
  });

  it("does not apply saved session filters to crypto during overnight hours", () => {
    const restrictedRules = { ...rules, session_filter: true, allowed_sessions: ["LONDON"] };
    const result = evaluate(restrictedRules, newGuardianState(), { ...base, session: "OFF_HOURS" });
    expect(result.checks.find((c) => c.name === "Session")).toMatchObject({
      passed: true, detail: expect.stringContaining("crypto trades 24/7")
    });
  });

  it("accepts a 1:2 plan whose prices were rounded to the tick grid", () => {
    const r = evaluate(rules, newGuardianState(), { ...base, entry: 94637, stop: 95190.6, tp1: 93529.9, direction: "SHORT", analystBias: "BEARISH_SWEEP_SHORT", spec: { ...spec, contractValue: 0.001 } });
    expect(r.checks.find((c) => c.name === "Risk:Reward")!.passed).toBe(true);
  });
});

describe("Analyst guardrails", () => {
  const [setup] = detectAt(sweepSeries(100.701), 39, [LEVEL], "SOLUSD", DEFAULT_PARAMS) as [Setup];

  it("pins entry/SL to the Hunter and resets targets beyond the candidate range", () => {
    const d = mockDecision(setup);
    const tampered = { ...d, trade_plan: { ...d.trade_plan, entry_price: 99, stop_loss: 101.5, take_profit_2: setup.take_profit_2 - 10 } };
    const { decision, notes } = clampToCandidate(tampered, setup);
    expect(decision.trade_plan.entry_price).toBe(setup.entry_price);
    expect(decision.trade_plan.stop_loss).toBe(setup.stop_loss);
    expect(decision.trade_plan.take_profit_2).toBe(setup.take_profit_2);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("treats a contradicting bias as NO_TRADE and rejects inconsistent JSON plans", () => {
    expect(clampToCandidate({ ...mockDecision(setup), bias: "BULLISH_SWEEP_LONG" }, setup).decision.bias).toBe("NO_TRADE");
    const bad = JSON.stringify({ ...mockDecision(setup), bias: "BULLISH_SWEEP_LONG", trade_plan: { entry_price: 100, stop_loss: 101, take_profit_1: 102, take_profit_2: 103, risk_reward_ratio: 2 } });
    expect(() => parseDecision(`Here you go: ${bad}`)).toThrow();
  });
});

describe("paper engine", () => {
  it("moves to break-even at 1R, closes half at TP1 and the rest at TP2", () => {
    specFor("SOLUSD").contractValue = 1;
    const engine = new PaperEngine(1000, T0);
    engine.open({ signalId: "x", instrument: "SOLUSD", direction: "LONG", volume: 10, price: 100, sl: 99, tp1: 102, tp2: 103, ts: T0 });
    const bar = (high: number, close: number, k: number): Bar => ({ time: T0 + k * 300, open: close, high, low: close - 0.5, close, volume: 1 });
    expect(engine.onCandle("SOLUSD", bar(101.1, 101, 1)).map((e) => e.type)).toEqual(["be"]);
    expect(engine.onCandle("SOLUSD", bar(102.2, 102, 2)).map((e) => e.type)).toEqual(["tp1"]);
    expect(engine.onCandle("SOLUSD", bar(103, 102.9, 3)).map((e) => e.type)).toEqual(["tp2"]);
    expect(engine.closed[0]!.realized_pnl).toBe(25);
    expect(engine.balance).toBe(1025);
  });
});

describe("Delta India bridge", () => {
  const json = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });

  it("rejects missing or malformed wallet balances instead of fabricating a zero balance", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const bridge = new DeltaBridge({ apiKey: "k", apiSecret: "s", environment: "testnet", liveTradingConfirmed: false }, undefined, fetcher);
    for (const result of [[], [{ asset_symbol: "USD", balance: "invalid", available_balance: "1" }], [{ asset_symbol: "USD", balance: null, available_balance: "1" }]]) {
      fetcher.mockResolvedValueOnce(json(result));
      await expect(bridge.wallet()).rejects.toThrow(/wallet/);
    }
  });

  it("reads account positions outside the configured strategy symbols", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([
      { product_symbol: "SOLUSD", product_id: 99, size: -2, entry_price: "100", mark_price: "90", unrealized_pnl: "20" }
    ]));
    const bridge = new DeltaBridge({ apiKey: "k", apiSecret: "s", environment: "testnet", liveTradingConfirmed: false }, undefined, fetcher);
    expect(await bridge.positions()).toMatchObject([{ symbol: "SOLUSD", direction: "SHORT", unrealizedPnl: 20 }]);
  });

  it("values the nested margined-position format using actual exchange marks and contract values", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith("/v2/positions/margined")) {
        return json([{ size: -2, entry_price: "100", product: { id: 99, symbol: "SOLUSD", contract_value: "0.1" } }]);
      }
      if (String(url).endsWith("/v2/tickers/SOLUSD")) return json({ mark_price: "90", quotes: { best_bid: "89", best_ask: "91" } });
      throw new Error("Unexpected request");
    });
    const bridge = new DeltaBridge({ apiKey: "k", apiSecret: "s", environment: "testnet", liveTradingConfirmed: false }, undefined, fetcher);
    expect(await bridge.positions()).toEqual([{ symbol: "SOLUSD", productId: 99, direction: "SHORT", contracts: 2, entryPrice: 100, markPrice: 90, unrealizedPnl: 2 }]);
  });

  it("maps account fills newest-first with numeric prices and timestamps", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([
      { id: "f1", product_symbol: "BTCUSD", side: "sell", size: "2", price: "62579.5", commission: "0.03", notional: "125.1", order_id: 9, role: "taker", created_at: "2026-11-18T20:34:25Z" },
      { id: "bad", product_symbol: "BTCUSD", side: "buy", size: "1", price: "x", created_at: "2026-11-18T20:34:20Z" }
    ]));
    const bridge = new DeltaBridge({ apiKey: "k", apiSecret: "s", environment: "testnet", liveTradingConfirmed: false }, undefined, fetcher);
    expect(await bridge.fills()).toEqual([{ id: "f1", symbol: "BTCUSD", side: "sell", size: 2, price: 62579.5, commission: 0.03, notional: 125.1, order_id: "9", role: "taker", time: Date.parse("2026-11-18T20:34:25Z") / 1000 }]);
  });

  it("returns closed 5M candles oldest-first and drops the in-progress bar", async () => {
    const now = T0 + 1000 * 300 + 120;
    const live = T0 + 1000 * 300;
    const fetcher = vi.fn(async () => json([
      { time: live, open: 1, high: 2, low: 1, close: 2, volume: 1 },
      { time: live - 300, open: 1, high: 2, low: 1, close: 1.5, volume: 1 },
      { time: live - 600, open: 1, high: 2, low: 1, close: 1.2, volume: 1 }
    ]));
    const bridge = new DeltaBridge({ apiKey: "", apiSecret: "", environment: "testnet", liveTradingConfirmed: false }, undefined, fetcher as unknown as typeof fetch);
    const bars = await bridge.candles5m("BTCUSD", 3, now);
    expect(bars.map((b) => b.time)).toEqual([live - 600, live - 300]);
  });

  it("refuses real-money orders until live is explicitly unlocked", async () => {
    const fetcher = vi.fn();
    const bridge = new DeltaBridge({ apiKey: "k", apiSecret: "s", environment: "production", liveTradingConfirmed: true }, undefined, fetcher as unknown as typeof fetch);
    bridge.lastHealth.authenticated = true;
    const res = await bridge.placeEntry({ signalId: "a", symbol: "BTCUSD", direction: "LONG", contracts: 1, stop: 90, target: 110, leverage: 2 });
    expect(res.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends a signed market order with a tick-rounded exchange bracket", async () => {
    const posted: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("/v2/products/BTCUSD")) return json({ id: 84, contract_value: "0.001", tick_size: "0.5", initial_margin: "1", state: "live", trading_status: "operational" });
      if (url.includes("/v2/tickers/")) return json({ mark_price: "60000", quotes: { best_bid: "59999.5", best_ask: "60000.5" } });
      posted.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
      return url.endsWith("/v2/orders") ? json({ id: 7, state: "closed", size: 3, unfilled_size: 0, average_fill_price: "59999.5" }) : json({});
    });
    const bridge = new DeltaBridge({ apiKey: "k", apiSecret: "s", environment: "testnet", liveTradingConfirmed: false }, undefined, fetcher as unknown as typeof fetch);
    bridge.lastHealth.authenticated = true;
    const res = await bridge.placeEntry({ signalId: "sig-1", symbol: "BTCUSD", direction: "SHORT", contracts: 3, stop: 60300.2, target: 59100.7, leverage: 10 });
    expect(res.ok).toBe(true);
    const order = posted.find((p) => p.url.endsWith("/v2/orders"))!;
    expect(order.body).toMatchObject({ product_id: 84, size: 3, side: "sell", order_type: "market_order", bracket_stop_loss_price: "60300", bracket_take_profit_price: "59101" });
    expect(order.body.client_order_id).toMatch(/^[a-f0-9]{32}$/);
    expect(order.headers.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports the rejected client IP when the API key is not whitelisted for it", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/v2/products/BTCUSD")) return json({ id: 27, contract_value: "0.001", tick_size: "0.5", initial_margin: "1", state: "live", trading_status: "operational" });
      return new Response(JSON.stringify({ success: false, error: { code: "ip_not_whitelisted_for_api_key", context: { client_ip: "2401:db8::1" } } }), { status: 401 });
    });
    const bridge = new DeltaBridge({ apiKey: "k", apiSecret: "s", environment: "production", liveTradingConfirmed: false }, undefined, fetcher as unknown as typeof fetch);
    const health = await bridge.health(["BTCUSD"]);
    expect(health.authenticated).toBe(false);
    expect(health.issues.find((i) => i.code === "IP_NOT_WHITELISTED")?.message).toContain("2401:db8::1");
  });
});

describe("desk pipeline", () => {
  it("runs a planted demo sweep through all seven agents into a journaled paper trade", async () => {
    const cfg = { ...loadDeskConfig({ DESK_INSTRUMENTS: "BTCUSD", DESK_DEMO_MODE: "true" }), analystApiKey: "" };
    const db = new DeskDatabase(":memory:");
    const desk = new Desk(cfg, new EventHub(), { db });
    const market = desk.feed.markets.BTCUSD!;
    expect(market.forceScenario(mapLiquidity(market.candles.slice(-900), desk.params))).not.toBeNull();
    let taken = null;
    for (let k = 0; k < 20 && !taken; k += 1) {
      desk.paper.onCandle("BTCUSD", market.step());
      const ctx = await desk.runPipeline("BTCUSD");
      if (ctx.outcome === "taken") taken = ctx;
    }
    expect(taken?.trace.map((r) => r.agent)).toEqual(["Scout", "Cartographer", "Hunter", "Analyst", "Guardian", "Executioner", "Chronicler"]);
    expect(desk.paper.positions.size).toBe(1);
    expect(db.decisions(5)[0]!.outcome).toBe("taken");
    db.close();
  });

  describe("live desk data integrity", () => {
    it("refuses entries before consuming a signal when account or quote data is stale", async () => {
      const db = new DeskDatabase(":memory:");
      const desk = new Desk(loadDeskConfig({ DESK_INSTRUMENTS: "BTCUSD" }), new EventHub(), { db });
      const claim = vi.spyOn(db, "claimSignal");
      try {
        expect(await desk.sendDeltaOrder(newContext("BTCUSD", "1"))).toMatchObject({ ok: false, message: expect.stringContaining("account data") });
        desk.accountUpdatedAt = Date.now() / 1000;
        expect(await desk.sendDeltaOrder(newContext("BTCUSD", "2"))).toMatchObject({ ok: false, message: expect.stringContaining("market data") });
        expect(claim).not.toHaveBeenCalled();
      } finally {
        await desk.stop();
        db.close();
      }
    });

    it("refuses test orders on production even when real-money execution is unlocked", async () => {
      const db = new DeskDatabase(":memory:");
      const fetcher = vi.fn<typeof fetch>();
      const desk = new Desk(loadDeskConfig({ DELTA_ENV: "production", LIVE_TRADING_CONFIRMED: "I_UNDERSTAND_REAL_MONEY", DELTA_LIVE_API_KEY: "k", DELTA_LIVE_API_SECRET: "s" }), new EventHub(), { db, fetcher });
      desk.delta.liveUnlocked = true;
      desk.delta.lastHealth.authenticated = true;
      try {
        expect(await desk.sendTestOrder("BTCUSD")).toMatchObject({ ok: false, message: expect.stringContaining("only allowed") });
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        await desk.stop();
        db.close();
      }
    });

    it("defaults to Delta and never mixes scoped credentials with legacy keys", () => {
      const cfg = loadDeskConfig({
        DELTA_ENV: "production", DELTA_DEMO_API_KEY: "demo", DELTA_DEMO_API_SECRET: "demo-secret",
        DELTA_API_KEY: "legacy", DELTA_API_SECRET: "legacy-secret", DELTA_LIVE_API_KEY: "live"
      });
      expect(cfg.demoMode).toBe(false);
      expect(cfg.execution).toBe("paper");
      expect(cfg.deltaApiKey).toBe("live");
      expect(cfg.deltaApiSecret).toBe("");
      const legacy = loadDeskConfig({ DELTA_API_KEY: "legacy", DELTA_API_SECRET: "secret" });
      expect(legacy.deltaApiKey).toBe("legacy");
      expect(legacy.deltaApiSecret).toBe("secret");
    });

    it("allows explicit Delta execution only with Demo credentials and exchange market data", () => {
      const cfg = loadDeskConfig({
        DELTA_ENV: "testnet", DELTA_DEMO_API_KEY: "demo", DELTA_DEMO_API_SECRET: "demo-secret", DESK_EXECUTION: "delta"
      });
      expect(cfg.execution).toBe("delta");
      const db = new DeskDatabase(":memory:");
      const desk = new Desk(cfg, new EventHub(), { db });
      try {
        expect(desk.execution).toBe("delta");
      } finally {
        db.close();
      }
      expect(() => loadDeskConfig({ DESK_EXECUTION: "delta" })).toThrow(/complete Demo Delta credential pair/);
      expect(() => loadDeskConfig({
        DESK_EXECUTION: "delta", DESK_DEMO_MODE: "true", DELTA_DEMO_API_KEY: "k", DELTA_DEMO_API_SECRET: "s"
      })).toThrow(/synthetic DESK_DEMO_MODE is incompatible/);
      expect(() => loadDeskConfig({
        DESK_EXECUTION: "delta", DELTA_ENV: "production", DELTA_LIVE_API_KEY: "k", DELTA_LIVE_API_SECRET: "s"
      })).toThrow(/restricted to DELTA_ENV=testnet/);
    });

    it("counts only closed trades from the selected execution venue", () => {
      const db = new DeskDatabase(":memory:");
      const cfg = loadDeskConfig({
        DESK_INSTRUMENTS: "BTCUSD", DESK_EXECUTION: "delta", DELTA_DEMO_API_KEY: "demo", DELTA_DEMO_API_SECRET: "demo-secret"
      });
      const desk = new Desk(cfg, new EventHub(), { db });
      const trade = (id: string, venue: Position["venue"], pnl: number): Position => ({
        id, signal_id: id, instrument: "BTCUSD", direction: "LONG", volume: 1, initial_volume: 1,
        entry_price: 100, stop_loss: 90, initial_stop: 90, take_profit_1: 120, take_profit_2: 130,
        opened_at: 1, status: "closed", closed_at: 2, exit_price: 110, realized_pnl: pnl, unrealized_pnl: 0,
        tp1_hit: false, breakeven: false, venue, close_reason: "TP2"
      });
      try {
        db.recordTrade(trade("paper-win", "paper", 10));
        db.recordTrade(trade("delta-win", "delta", 10));
        db.recordTrade(trade("delta-loss", "delta", -5));
        expect(desk.kpis()).toMatchObject({ trades: 2, win_rate: 50 });
      } finally {
        db.close();
      }
    });

    it("builds the Delta equity curve only from reconciled exchange account values", async () => {
      const db = new DeskDatabase(":memory:");
      const hub = new EventHub();
      const emit = vi.spyOn(hub, "emit");
      const cfg = loadDeskConfig({
        DESK_INSTRUMENTS: "BTCUSD", DESK_EXECUTION: "delta", DELTA_DEMO_API_KEY: "demo", DELTA_DEMO_API_SECRET: "demo-secret"
      });
      const desk = new Desk(cfg, hub, { db });
      vi.spyOn(desk.delta, "wallet").mockResolvedValue({ balance: 125, available: 100, asset: "USD" });
      vi.spyOn(desk.delta, "positions").mockResolvedValue([]);
      vi.spyOn(desk.delta, "fills").mockResolvedValue([]);
      try {
        await desk.syncDelta();
        const curve = desk.snapshot().equity_curve as Array<{ time: number; equity: number }>;
        expect(curve).toHaveLength(1);
        expect(curve[0]!.equity).toBe(125);
        expect(curve[0]!.equity).not.toBe(cfg.startingBalance);
        expect(emit).toHaveBeenCalledWith("delta_sync", expect.objectContaining({
          equity_point: expect.objectContaining({ equity: 125 })
        }));
      } finally {
        await desk.stop();
        db.close();
      }
    });

    it("streams forming candles and marks without exposing them as closed strategy bars", async () => {
      const stream = new DeltaMarketStream();
      const db = new DeskDatabase(":memory:");
      const hub = new EventHub();
      const emit = vi.spyOn(hub, "emit");
      const desk = new Desk(loadDeskConfig({ DESK_INSTRUMENTS: "BTCUSD,ETHUSD" }), hub, { db, stream });
      try {
        stream.emit("candle", { symbol: "ETHUSD", timeframe: "5m", candle: { timestamp: T0 * 1000, open: "100", high: "102", low: "99", close: "101", volume: "10" } });
        stream.emit("ticker", { symbol: "ETHUSD", markPrice: "101.5", receivedAt: Date.now() });
        expect(desk.chartBars("ETHUSD", 20)).toMatchObject([{ time: T0, close: 101 }]);
        expect(desk.bars("ETHUSD", 20)).toEqual([]);
        expect(desk.quotes.ETHUSD?.mark).toBe(101.5);
        expect(emit).toHaveBeenCalledWith("market", expect.objectContaining({ candles: { ETHUSD: expect.objectContaining({ close: 101 }) } }));
        expect(desk.cycles).toBe(0);
      } finally {
        await desk.stop();
        db.close();
      }
    });

    it("keeps live mode during an outage and does not switch account execution to paper", async () => {
      const db = new DeskDatabase(":memory:");
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
      const desk = new Desk(loadDeskConfig({ DESK_INSTRUMENTS: "BTCUSD" }), new EventHub(), { db, fetcher });
      desk.execution = "delta";
      try {
        await desk.refreshHealth();
        expect(desk.dataSource).toBe("delta");
        expect(desk.execution).toBe("delta");
        expect(desk.bars("BTCUSD", 20)).toEqual([]);
        expect(desk.delta.isReady()).toBe(false);
      } finally {
        await desk.stop();
        db.close();
      }
    });

    it("syncs the actual account in paper mode and preserves explicitly stale data on failure", async () => {
      const db = new DeskDatabase(":memory:");
      const desk = new Desk(loadDeskConfig({ DELTA_DEMO_API_KEY: "k", DELTA_DEMO_API_SECRET: "s" }), new EventHub(), { db });
      vi.spyOn(desk.delta, "wallet").mockResolvedValue({ balance: 123, available: 100, asset: "USD" });
      vi.spyOn(desk.delta, "positions").mockResolvedValue([
        { symbol: "SOLUSD", productId: 99, direction: "LONG", contracts: 2, entryPrice: 10, markPrice: 12, unrealizedPnl: 4 }
      ]);
      try {
        await desk.syncDelta();
        expect(desk.execution).toBe("paper");
        expect(desk.accountSnapshot()).toMatchObject({ equity: 127, wallet: { balance: 123 }, positions: [{ instrument: "SOLUSD" }], error: null });
        const lastUpdate = desk.accountUpdatedAt;
        vi.mocked(desk.delta.wallet).mockRejectedValueOnce(new Error("authentication failed"));
        const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        await desk.syncDelta();
        log.mockRestore();
        expect(desk.accountUpdatedAt).toBe(lastUpdate);
        expect(desk.accountSnapshot()).toMatchObject({ equity: 127, error: "authentication failed" });
      } finally {
        await desk.stop();
        db.close();
      }
    });
  });
});
