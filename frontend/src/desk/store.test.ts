import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getState, handleFrame, loadCandles, setState } from "./store";
import type { CycleSummary } from "./types";

const cycle = (id: string, withSetup: boolean, levels = 1): CycleSummary => ({
  instrument: "BTCUSD", cycle_id: id, outcome: withSetup ? "taken" : "none", ts: 1,
  setup: withSetup ? ({ signal_id: id } as CycleSummary["setup"]) : null,
  decision: null, checks: [], levels: Array.from({ length: levels }, (_, i) => ({ name: `L${i}`, price: 100 + i, side: "high", strength: 1 })),
  trace: [], execution: {}
});

describe("desk stream reducer", () => {
  beforeEach(() => setState({ lastCycle: {}, candles: {}, journalTick: 0 }));
  afterEach(() => vi.unstubAllGlobals());

  it("shows the latest cycle rather than representing an old setup as current", () => {
    handleFrame({ type: "cycle_end", data: cycle("a", true), ts: 1 });
    handleFrame({ type: "cycle_end", data: cycle("b", false, 3), ts: 2 });
    const kept = getState().lastCycle.BTCUSD!;
    expect(kept.cycle_id).toBe("b");
    expect(kept.setup).toBeNull();
    expect(kept.levels).toHaveLength(3);
    expect(getState().journalTick).toBe(1);
  });

  it("replaces the forming candle and appends new ones from market frames", () => {
    setState({ candles: { BTCUSD: [{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 }] } });
    const market = (time: number, close: number) => ({
      type: "market", ts: 0,
      data: { candles: { BTCUSD: { time, open: 1, high: 2, low: 1, close, volume: 1 } }, kpis: null, positions: [], session: null, mode: "DEMO", equity_point: { time, equity: 1 } }
    });
    handleFrame(market(0, 1.5));
    handleFrame(market(300, 1.7));
    expect(getState().candles.BTCUSD!.map((c) => [c.time, c.close])).toEqual([[0, 1.5], [300, 1.7]]);
  });

  it("does not append a delayed closed candle after a newer forming candle", () => {
    const candle = { time: 600, open: 1, high: 2, low: 1, close: 1.5, volume: 1 };
    setState({ candles: { BTCUSD: [candle] } });
    handleFrame({
      type: "market", ts: 1, data: {
        candles: { BTCUSD: { ...candle, time: 300 } }, kpis: null, positions: [], session: null,
        mode: "PAPER", equity_point: { time: 1, equity: 1 }
      }
    });
    expect(getState().candles.BTCUSD).toEqual([candle]);
  });

  it("updates exchange account values even when order execution is disabled", () => {
    setState({ execution: "disabled", account: null });
    const account = { environment: "testnet", wallet: { balance: 123, available: 100, asset: "USD" }, equity: 123, positions: [], updated_at: 10, error: null };
    handleFrame({ type: "delta_sync", ts: 10, data: { account, positions: [] } });
    expect(getState().account).toEqual(account);
    handleFrame({ type: "delta_sync", ts: 20, data: { account: { ...account, error: "offline" } } });
    expect(getState().account?.error).toBe("offline");
    expect(getState().account?.updated_at).toBe(10);
  });

  it("appends reconciled exchange equity points from account syncs", () => {
    const account = { environment: "testnet", wallet: { balance: 123, available: 100, asset: "USD" }, equity: 123, positions: [], updated_at: 10, error: null };
    setState({ equity: [{ time: 9, equity: 120 }] });
    handleFrame({
      type: "delta_sync", ts: 10,
      data: { account, positions: [], equity_point: { time: 10, equity: 123 } }
    });
    expect(getState().equity).toEqual([{ time: 9, equity: 120 }, { time: 10, equity: 123 }]);
  });

  it("reconciles closed REST history without losing a forming candle received during the request", async () => {
    const bar = { time: 300, open: 1, high: 3, low: 1, close: 1.5, volume: 1 };
    setState({ dataSource: "delta", candles: { BTCUSD: [bar] } });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: true, candles: [{ ...bar, close: 2 }, { ...bar, time: 600, close: 2.2 }]
    }))));
    const loading = loadCandles("BTCUSD");
    handleFrame({
      type: "market", ts: 1, data: {
        candles: { BTCUSD: { ...bar, time: 600, close: 2.5 } }, kpis: null, positions: [], session: null,
        mode: "PAPER", equity_point: { time: 1, equity: 1 }
      }
    });
    await loading;
    expect(getState().candles.BTCUSD?.map((c) => [c.time, c.close])).toEqual([[300, 2], [600, 2.5]]);
    expect(getState().candleHistoryLoaded.BTCUSD).toBe(true);
  });
});
