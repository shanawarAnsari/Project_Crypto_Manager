/** Desk REST API + WebSocket stream (`/api/ws`). Educational use only; trading involves risk of loss. */
import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { WebSocketServer } from "ws";
import { PIPELINE_ORDER } from "./agents.js";
import { labRoutes } from "./lab-api.js";
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
  app.use((req, res, next) => {
    if (req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ ok: false, message: "Cross-site desk access is not allowed." });
    } else if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !req.is("application/json")) {
      res.status(415).json({ ok: false, message: "Desk commands require application/json." });
    } else next();
  });

  app.get("/api/health", wrap(() => ({
    ok: true, mode: desk.modeLabel(), data_source: desk.dataSource, execution: desk.execution, analyst: desk.analyst.mode,
    cycles: desk.cycles, ws_clients: desk.hub.clients.size, events_sent: desk.hub.sent, delta_connected: desk.delta.lastHealth.connected,
    delta_authenticated: desk.delta.lastHealth.authenticated, delta_env: desk.cfg.deltaEnvironment, time: new Date().toISOString()
  })));

  app.get("/api/state", wrap(() => ({ ...desk.snapshot(), strategy_id: desk.strategyId })));
  app.put("/api/strategy", wrap((req) => desk.selectStrategy(String(body(req).strategy_id ?? ""))));

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

  app.post("/api/kill", wrap((req, res) => {
    const b = body(req);
    if (typeof b.engaged !== "boolean" || (b.close_all !== undefined && typeof b.close_all !== "boolean"))
      return res.status(400).json({ ok: false, message: "Explicit boolean kill-switch command required." });
    return desk.engageKillSwitch(b.engaged, b.close_all === true);
  }));

  app.post("/api/pause", wrap((req, res) => {
    const paused = body(req).paused;
    if (typeof paused !== "boolean") return res.status(400).json({ ok: false, message: "Explicit boolean pause command required." });
    desk.paused = paused;
    desk.hub.emit("paused", { paused: desk.paused });
    return { ok: true, paused: desk.paused };
  }));

  app.use(labRoutes(desk.cfg.instruments, desk.cfg.startingBalance,
    progress => desk.hub.emit("backtest_progress", { progress: Math.round(progress * 1000) / 1000 })));

  app.post("/api/review", wrap(async () => {
    const day = new Date().toISOString().slice(0, 10);
    return { ok: true, day, text: await desk.writeReview(day) };
  }));

  // ---------------------------------------------------------------- Delta India
  app.get("/api/delta/status", wrap(async () => ({ ...(await desk.refreshHealth()), mode: desk.modeLabel() })));
  app.post("/api/delta/reconnect", wrap(async () => ({ ...(await desk.refreshHealth()), mode: desk.modeLabel() })));
  app.get("/api/delta/log", wrap((req) => ({ log: desk.db.execLog(Math.max(1, Math.min(Number(req.query.limit) || 100, 500))) })));

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
