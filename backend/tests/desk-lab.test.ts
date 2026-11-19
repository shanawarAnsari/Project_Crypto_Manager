import { once } from "node:events";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { runBacktest, type LabRequest } from "../src/desk/backtest.js";
import { fetchHistory, fetchLaunchTime, listingCoverage, validateRange } from "../src/desk/history.js";
import { labRoutes } from "../src/desk/lab-api.js";
import type { Bar } from "../src/desk/types.js";

const start = Date.UTC(2025, 0, 1) / 1000;
const opts: LabRequest = { instrument: "BTCUSD", resolution: "5m", start, end: start + 8 * 300,
  strategyId: "channel-6", feeBps: 5.9, slippageBps: 2, spreadBps: 1 };
const bar = (time: number): Bar => ({ time, open: 100, close: 100, high: 101, low: 99, volume: 12 });
const rows = () => Array.from({ length: 8 }, (_, i) => bar(start + i * 300));
const json = (result: unknown) => Response.json({ success: true, result });

describe("public Delta history", () => {
  it("uses the matching public product's real UTC launch time and rounds up only the initial partial bar", async () => {
    const listing = { symbol: "BTCUSD", launch_time: "2023-12-18T13:10:39Z" };
    const launch = await fetchLaunchTime(listing.symbol, async (url, init) => {
      expect(String(url)).toBe("https://api.india.delta.exchange/v2/products/BTCUSD");
      expect(init?.headers).toBeUndefined();
      return json(listing);
    });
    expect(listingCoverage("BTCUSD", "5m", launch, Date.UTC(2026, 0, 1)).earliestStart).toBe(Date.parse("2023-12-18T13:15:00Z") / 1000);
    expect(listingCoverage("BTCUSD", "1d", launch, Date.UTC(2032, 0, 1)).earliestStart).toBe(Date.UTC(2027, 0, 1) / 1000);
    await expect(fetchLaunchTime("ETHUSD", async () => json(listing))).rejects.toThrow("listing time unavailable");
    await expect(fetchLaunchTime("BTCUSD", async () => json({ ...listing, launch_time: null }))).rejects.toThrow("listing time unavailable");
  });
  it("requests consecutive bounded pages with no auth and orders the complete interval", async () => {
    const calls: URL[] = [];
    const http: typeof fetch = async (input, init) => {
      expect(init?.headers).toBeUndefined();
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.india.delta.exchange");
      calls.push(url);
      const from = Number(url.searchParams.get("start")), end = Number(url.searchParams.get("end")) + 1;
      return json(Array.from({ length: (end - from) / 300 }, (_, i) => bar(from + i * 300)).reverse());
    };
    const result = await fetchHistory({ ...opts, end: start + 2005 * 300 }, { http, now: Date.UTC(2026, 0, 1) });
    expect(calls.map(c => Number(c.searchParams.get("start")))).toEqual([start, start + 2000 * 300]);
    expect(result.map(b => b.time)).toEqual(Array.from({ length: 2005 }, (_, i) => start + i * 300));
  });
  it.each([
    [() => rows().slice(1), /missing/i],
    [() => [...rows(), bar(start)], /duplicate/i],
    [() => [{ ...bar(start), volume: null }], /invalid/i],
    [() => [{ ...bar(start), high: 98 }], /invalid/i],
    [() => [bar(opts.end)], /out-of-range/i],
  ] as const)("fails closed on unusable pages (%#)", async (make, msg) => {
    await expect(fetchHistory(opts, { now: Date.UTC(2026, 0, 1), http: async () => json(make()) })).rejects.toThrow(msg);
  });
  it("permits five calendar years but rejects earlier starts, forming bars and misaligned timestamps", () => {
    const now = Date.UTC(2030, 0, 1, 0, 2), end = Date.UTC(2030, 0, 1) / 1000;
    expect(() => validateRange({ ...opts, end }, now)).not.toThrow();
    for (const range of [{ ...opts, start: start - 300, end }, { ...opts, end: end + 300 }, { ...opts, start: start + 1 }])
      expect(() => validateRange(range, now)).toThrow();
  });
});

describe("cost-aware replay", () => {
  it.each(["long", "short"] as const)("enters %s on the next open, takes the adverse bracket first and reconciles every cost", async direction => {
    const bars = rows();
    const long = direction === "long";
    bars[6] = { ...bars[6]!, close: long ? 104 : 96, high: 105, low: 95 };
    bars[7] = { ...bars[7]!, open: 110, close: 111, high: 120, low: 90 };
    const res = await runBacktest(opts, bars, 10000);
    expect(res.trades).toHaveLength(1);
    const t = res.trades[0]!, s = res.stats;
    expect(t).toMatchObject({ time: bars[7]!.time, direction, reason: "Stop" });
    expect(t.entry).toBeCloseTo(110 * (1 + (long ? 1 : -1) * .00025));
    expect(s.fees).toBeGreaterThan(0);
    expect(s.spread).toBeGreaterThan(0);
    expect(s.slippage).toBeGreaterThan(0);
    expect(Math.abs(s.gross_pnl - s.fees - s.slippage - s.spread - s.net_pnl)).toBeLessThan(.03);
    expect(s.net_pnl).toBeLessThan(-100);
    expect(s.final_equity).toBeCloseTo(10000 + t.pnl);
  });
  it("does not turn a signal on the last bar into a trade", async () => {
    const bars = rows();
    bars[7] = { ...bars[7]!, close: 104, high: 105 };
    expect((await runBacktest(opts, bars, 10000)).stats.trades).toBe(0);
  });
});

it("serves the catalog, rejects unsafe requests before fetching, and reuses verified history across candidates", async () => {
  const end = Math.floor(Date.now() / 300000) * 300;
  const request = { ...opts, start: end - 20 * 300, end };
  const history = vi.fn(async () => Array.from({ length: 20 }, (_, i) => bar(request.start + i * 300)));
  const launch = vi.fn(async () => request.start - 42);
  const app = express(); app.use(express.json(), labRoutes(["BTCUSD"], 10000, () => {}, history, launch));
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Missing test listener");
    const base = `http://127.0.0.1:${addr.port}`;
    expect((await (await fetch(base + "/api/strategies")).json()).strategies.length).toBeGreaterThanOrEqual(100);
    const send = (body: object) => fetch(base + "/api/backtest", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    for (const invalid of [{ strategyId: "unknown" }, { feeBps: 0 }, { slippageBps: -1 }, { spreadBps: 0 }, { source: "synthetic" }]) {
      expect((await send({ ...request, ...invalid })).status).toBe(400);
    }
    expect(history).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(await (await fetch(base + "/api/lab/coverage?instrument=BTCUSD&resolution=5m")).json())
      .toMatchObject({ earliestStart: request.start, launchTime: request.start - 42 });
    const requestedStart = request.start - 86400;
    expect((await send({ ...request, start: requestedStart, end: request.start })).status).toBe(422);
    expect(history).not.toHaveBeenCalled();
    for (const strategyId of ["channel-6", "channel-8"]) {
      const response = await send({ ...request, start: requestedStart, strategyId });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, strategyId, source: "delta", candles: 20, requestedStart, start: request.start });
    }
    expect(history).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledWith(expect.objectContaining({ start: request.start }), expect.anything());
    expect(launch).toHaveBeenCalledTimes(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
