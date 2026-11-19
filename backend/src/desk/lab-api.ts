import { Router } from "express";
import { strategies, strategyById } from "./catalog.js";
import { MIN_SPREAD_BPS, runBacktest, type LabRequest } from "./backtest.js";
import { MIN_FEE_BPS, MIN_SLIPPAGE_BPS } from "./candidate-policy.js";
import { fetchHistory, fetchLaunchTime, listingCoverage, HistoryError, intervals, validateRange, type Resolution } from "./history.js";
import type { Bar } from "./types.js";

function parseRequest(input: unknown, instruments: readonly string[]): LabRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HistoryError("Invalid Lab request.", 400);
  const b = input as Record<string, unknown>;
  if (b.source !== undefined && b.source !== "delta") throw new HistoryError("Only public Delta history is supported.", 400);
  if (typeof b.instrument !== "string" || !instruments.includes(b.instrument)) throw new HistoryError("Unknown instrument.", 400);
  if (typeof b.strategyId !== "string" || !strategyById(b.strategyId)) throw new HistoryError("Select a catalog strategy.", 400);
  if (typeof b.resolution !== "string" || !Object.hasOwn(intervals, b.resolution)) throw new HistoryError("Unknown resolution.", 400);
  if (typeof b.start !== "number" || typeof b.end !== "number") throw new HistoryError("Specify UTC start and end in seconds.", 400);
  const costs = (key: string, fallback: number) => {
    const n = b[key] === undefined ? fallback : b[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < fallback || n > 100)
      throw new HistoryError(`${key} must be a number from ${fallback} to 100 basis points.`, 400);
    return n;
  };
  const opts = { instrument: b.instrument, strategyId: b.strategyId, resolution: b.resolution as Resolution,
    start: b.start, end: b.end, feeBps: costs("feeBps", MIN_FEE_BPS), slippageBps: costs("slippageBps", MIN_SLIPPAGE_BPS),
    spreadBps: costs("spreadBps", MIN_SPREAD_BPS) };
  validateRange(opts);
  if ((opts.end - opts.start) / intervals[opts.resolution] < strategyById(opts.strategyId)!.lookback + 2)
    throw new HistoryError("Too few candles for the strategy lookback. Widen the date range or choose a finer resolution.", 422);
  return opts;
}

export function labRoutes(instruments: readonly string[], startingBalance: number, progress: (fraction: number) => void,
  history = fetchHistory, launchTime = fetchLaunchTime): Router {
  const router = Router();
  let busy = false;
  let cache: { key: string; bars: Bar[]; until: number } | undefined;
  const launches = new Map<string, { value: Promise<number>; until: number }>();
  const coverage = async (instrument: string, resolution: Resolution) => {
    let hit = launches.get(instrument);
    if (!hit || hit.until <= Date.now()) {
      hit = { value: launchTime(instrument).catch(e => { launches.delete(instrument); throw e; }), until: Date.now() + 3600000 };
      launches.set(instrument, hit);
    }
    return listingCoverage(instrument, resolution, await hit.value);
  };
  router.get("/api/lab/coverage", async (req, res) => {
    const { instrument, resolution } = req.query;
    if (typeof instrument !== "string" || !instruments.includes(instrument) || typeof resolution !== "string" || !Object.hasOwn(intervals, resolution)) {
      res.status(400).json({ ok: false, message: "Unknown instrument or resolution." });
      return;
    }
    try { res.json({ ok: true, ...await coverage(instrument, resolution as Resolution) }); }
    catch { res.status(502).json({ ok: false, message: `Delta listing time unavailable for ${instrument}.` }); }
  });
  router.get("/api/strategies", (_req, res) => { res.json({ strategies }); });
  router.post("/api/backtest", async (req, res) => {
    if (busy) { res.status(409).json({ ok: false, message: "Another Lab run is in progress." }); return; }
    busy = true;
    const ctl = new AbortController();
    const cancel = () => ctl.abort();
    res.once("close", cancel);
    try {
      const opts = parseRequest(req.body, instruments);
      const requestedStart = opts.start;
      const listing = await coverage(opts.instrument, opts.resolution);
      ctl.signal.throwIfAborted();
      opts.start = Math.max(requestedStart, listing.earliestStart);
      if (opts.end <= opts.start || (opts.end - opts.start) / intervals[opts.resolution] < strategyById(opts.strategyId)!.lookback + 2)
        throw new HistoryError(`Too few post-listing candles. Earliest eligible start: ${new Date(listing.earliestStart * 1000).toISOString()}. Choose a later end or finer resolution.`, 422);
      const key = JSON.stringify([opts.instrument, opts.resolution, opts.start, opts.end]);
      progress(0);
      if (!cache || cache.key !== key || cache.until < Date.now()) {
        cache = undefined;
        const bars = await history(opts, { progress: f => progress(.8 * f), signal: ctl.signal });
        cache = { key, bars, until: Date.now() + 15 * 60_000 };
      }
      const result = await runBacktest(opts, cache.bars, startingBalance, f => progress(.8 + .2 * f), ctl.signal);
      res.json({ ok: true, ...result, requestedStart, coverage: listing });
    } catch (e) {
      if (!ctl.signal.aborted) {
        const known = e instanceof HistoryError;
        res.status(known ? e.status : 500).json({ ok: false, message: known ? e.message : "The Lab run failed." });
      }
    } finally {
      busy = false;
      res.off("close", cancel);
    }
  });
  return router;
}
