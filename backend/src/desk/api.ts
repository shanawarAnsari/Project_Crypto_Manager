/** Desk REST API + WebSocket stream (`/api/ws`). Educational use only; trading involves risk of loss. */
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer } from "ws";
import { PIPELINE_ORDER } from "./agents.js";
import { runBacktest } from "./backtest.js";
import { CONFIRM_PHRASE } from "./delta-bridge.js";
import type { Desk } from "./orchestrator.js";
import { mergeRules, validateRules } from "./risk.js";
import { mergeParams, validateParams } from "./strategy.js";

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).then((body) => {
    if (!res.headersSent) res.json(body);
  }).catch(next);
};

const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {});

export function createDeskApp(desk: Desk): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", wrap(() => ({
    ok: true, mode: desk.modeLabel(), data_source: desk.dataSource, execution: desk.execution, analyst: desk.analyst.mode,
    cycles: desk.cycles, ws_clients: desk.hub.clients.size, events_sent: desk.hub.sent, delta_connected: desk.delta.lastHealth.connected,
    delta_authenticated: desk.delta.lastHealth.authenticated, delta_env: desk.cfg.deltaEnvironment, time: new Date().toISOString()
  })));

  app.get("/api/state", wrap(() => ({ ...desk.snapshot(), confirm_phrase: CONFIRM_PHRASE })));

  app.get("/api/candles", wrap((req) => {
    const instrument = String(req.query.instrument ?? desk.cfg.instruments[0]);
    if (!desk.cfg.instruments.includes(instrument)) return { ok: false, message: `Unknown instrument ${instrument}` };
    const n = Math.max(50, Math.min(Number(req.query.n) || 400, 2000));
    return { ok: true, instrument, candles: desk.chartBars(instrument, n), last_cycle: desk.lastCycle[instrument] ?? null };
  }));

  app.get("/api/journal", wrap((req) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 150, 500));
    const outcome = typeof req.query.outcome === "string" && req.query.outcome ? req.query.outcome : undefined;
    return { decisions: desk.db.decisions(limit, outcome), trades: desk.db.trades(200), reviews: desk.db.reviews() };
  }));

  app.post("/api/mode", wrap(async (req) => {
    const b = body(req);
    const res = await desk.setMode({
      ...(typeof b.data_source === "string" ? { data_source: b.data_source } : {}),
      ...(typeof b.execution === "string" ? { execution: b.execution } : {})
    });
    return { ...res, mode: desk.modeLabel(), data_source: desk.dataSource, execution: desk.execution };
  }));

  app.put("/api/settings", wrap((req) => {
    const b = body(req);
    const rules = mergeRules(desk.rules, (b.rules ?? {}) as Record<string, unknown>);
    const params = mergeParams(desk.params, (b.params ?? {}) as Record<string, unknown>);
    const errors = [...validateRules(rules, desk.cfg.maxLeverage), ...validateParams(params, rules.min_rr)];
    if (errors.length || b.validate_only) return { ok: errors.length === 0, errors };
    desk.updateSettings(rules, params);
    return { ok: true, errors: [], rules, params };
  }));

  app.post("/api/kill", wrap((req) => desk.engageKillSwitch(Boolean(body(req).engaged), Boolean(body(req).close_all))));

  app.post("/api/pause", wrap((req) => {
    desk.paused = Boolean(body(req).paused);
    desk.hub.emit("paused", { paused: desk.paused });
    return { ok: true, paused: desk.paused };
  }));

  app.post("/api/demo/scenario", wrap((req) => desk.runDemoScenario(typeof body(req).instrument === "string" ? String(body(req).instrument) : undefined)));

  app.post("/api/paper/close/:id", wrap((req) => desk.closePaper(String(req.params.id))));

  app.post("/api/backtest", wrap(async (req) => {
    const b = body(req);
    const instrument = String(b.instrument ?? desk.cfg.instruments[0]);
    if (!desk.cfg.instruments.includes(instrument)) return { ok: false, message: "Unknown instrument" };
    const source = b.source === "delta" ? "delta" : "synthetic";
    const days = Math.max(source === "delta" ? 3 : 10, Math.min(Number(b.days) || 30, source === "delta" ? 60 : 180));
    const candles = source === "delta" ? await desk.delta.candles5m(instrument, days * 288) : undefined;
    if (candles && candles.length < 400) return { ok: false, message: "Not enough Delta India history returned for this range." };
    const res = await runBacktest({
      instrument, days, rules: desk.rules, params: desk.params, startingBalance: desk.cfg.startingBalance, seed: Number(b.seed) || 42,
      ...(candles ? { candles } : {}), progress: (x) => desk.hub.emit("backtest_progress", { progress: Math.round(x * 1000) / 1000 })
    });
    return { ok: true, ...res };
  }));

  app.post("/api/review", wrap(async () => {
    const day = new Date().toISOString().slice(0, 10);
    return { ok: true, day, text: await desk.writeReview(day) };
  }));

  // ---------------------------------------------------------------- Delta India
  app.get("/api/delta/status", wrap(async () => ({ ...(await desk.refreshHealth()), mode: desk.modeLabel() })));
  app.post("/api/delta/reconnect", wrap(async () => ({ ...(await desk.refreshHealth()), mode: desk.modeLabel() })));
  app.get("/api/delta/log", wrap((req) => ({ log: desk.db.execLog(Math.max(1, Math.min(Number(req.query.limit) || 100, 500))) })));

  app.post("/api/delta/live", wrap(async (req) => {
    const b = body(req);
    if (!b.enable) {
      desk.delta.liveUnlocked = false;
      await desk.refreshHealth();
      return { ok: true, live_unlocked: false, message: "Live trading locked." };
    }
    if (desk.cfg.deltaEnvironment !== "production") return { ok: false, live_unlocked: false, message: "DELTA_ENV is testnet: the desk trades the Delta Demo account, no unlock needed." };
    if (!desk.delta.allowLiveEnv) return { ok: false, live_unlocked: false, message: "Live is hard-disabled: set LIVE_TRADING_CONFIRMED=I_UNDERSTAND_REAL_MONEY in .env and restart." };
    if (String(b.phrase ?? "").trim() !== CONFIRM_PHRASE) return { ok: false, live_unlocked: false, message: `Type exactly "${CONFIRM_PHRASE}" to unlock live trading.` };
    desk.delta.liveUnlocked = true;
    await desk.refreshHealth();
    desk.toast({ level: "error", title: "LIVE TRADING UNLOCKED", message: "Orders may now be sent to your real-money Delta India account. Risk of loss is real." });
    return { ok: true, live_unlocked: true, message: "Live trading unlocked for this session." };
  }));

  app.post("/api/delta/test-order", wrap(async (req) => {
    const instrument = String(body(req).instrument ?? desk.cfg.instruments[0]);
    if (!desk.cfg.instruments.includes(instrument)) return { ok: false, message: "Unknown instrument" };
    const res = await desk.sendTestOrder(instrument);
    desk.toast({ level: res.ok ? "success" : "error", title: "Delta test order", message: res.message });
    return res;
  }));

  app.post("/api/delta/close/:symbol", wrap((req) => desk.closeDelta(String(req.params.symbol))));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    process.stderr.write(`API error: ${err instanceof Error ? err.stack : String(err)}\n`);
    res.status(500).json({ ok: false, message: "Something went wrong on the desk. It has been logged; please retry." });
  });
  return app;
}

/** Attach the live event stream to an HTTP server at `/api/ws`. */
export function attachDeskSocket(server: Server, desk: Desk): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/api/ws" });
  wss.on("connection", (ws) => {
    desk.hub.clients.add(ws);
    ws.send(JSON.stringify({ type: "hello", data: { mode: desk.modeLabel(), pipeline: PIPELINE_ORDER }, ts: Date.now() / 1000 }));
    ws.on("message", (msg) => {
      if (msg.toString() === "ping") ws.send(JSON.stringify({ type: "pong", data: {}, ts: Date.now() / 1000 }));
    });
    ws.on("close", () => desk.hub.clients.delete(ws));
    ws.on("error", () => desk.hub.clients.delete(ws));
  });
  return wss;
}
