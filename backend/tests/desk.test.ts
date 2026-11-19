import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadDeskConfig } from "../src/desk/config.js";
import { DeskDatabase } from "../src/desk/db.js";
import { DeltaBridge } from "../src/desk/delta-bridge.js";
import { Desk, EventHub } from "../src/desk/orchestrator.js";
import { DeltaMarketStream } from "../src/exchange/market-stream.js";
import { bracketPrices, budgetedLossPerContract } from "../src/desk/candidate-policy.js";

const demo = { DESK_INSTRUMENTS:"BTCUSD", DELTA_DEMO_API_KEY:"fixture", DELTA_DEMO_API_SECRET:"fixture", DESK_EXECUTION:"delta" };
const product = { symbol:"BTCUSD", id:84, initial_margin:"0.5", contract_value:".001", tick_size:".1", state:"live",
  trading_status:"operational", is_quanto:false, position_size_limit:5000, contract_type:"perpetual_futures", notional_type:"vanilla", taker_commission_rate:".0005",
  quoting_asset:{symbol:"USD"}, settling_asset:{symbol:"USD"} };
const json = (result: unknown) => new Response(JSON.stringify({success:true,result}));
const last = () => (Math.floor(Date.now()/300_000)-1)*300;
const bars = () => Array.from({length:60}, (_,i) => ({
  time:last() - (59-i)*300, open:100, close:i===59?104:100, high:i===59?105:101, low:99, volume:100
}));
const disposers: Array<() => void|Promise<void>> = [];
afterEach(async () => { for (const f of disposers.splice(0).reverse()) await f(); vi.restoreAllMocks(); });

/** Transport is intentionally incapable of any writes or network I/O. */
function fixture(env: NodeJS.ProcessEnv = demo) {
  const replies: Record<string, unknown> = {
    "/v2/products/BTCUSD":product, "/v2/positions/margined":[], "/v2/wallet/balances":[{asset_symbol:"USD", balance:"120",available_balance:"100"}],
    "/v2/orders":[], "/v2/fills":[], "/v2/history/candles":bars(), "/v2/tickers/BTCUSD":{symbol:"BTCUSD",timestamp:Date.now()*1000, mark_price:"104", quotes:{best_bid:"103.99",best_ask:"104"}}
  };
  const fetcher = vi.fn<typeof fetch>(async (url, opts) => {
    const u = new URL(String(url));
    if (u.origin !== "https://cdn-ind.testnet.deltaex.org" || opts?.method !== "GET" || opts.redirect !== "error" || !(u.pathname in replies)) {
      throw new Error("Forbidden fixture request");
    }
    return json(replies[u.pathname]);
  });
  const db = new DeskDatabase(":memory:");
  const stream = new DeltaMarketStream();
  vi.spyOn(stream,"connect").mockImplementation(() => undefined);
  const hub = new EventHub();
  const desk = new Desk(loadDeskConfig(env),hub,{stream,db,fetcher});
  disposers.push(async () => { await desk.stop(); db.close(); });
  return {desk,db,stream,replies,fetcher};
}

describe("demo-only desk", () => {
  it("ignores legacy and live keys; rejects production, synthetic data and missing scoped opt-in", () => {
    expect(loadDeskConfig({DELTA_API_KEY:"unused",DELTA_LIVE_API_SECRET:"unused"})).toMatchObject({deltaApiKey:"",deltaApiSecret:"", execution:"disabled"});
    expect(loadDeskConfig({DESK_EXECUTION:"paper"}).execution).toBe("disabled");
    expect(loadDeskConfig({}).maxLeverage).toBe(2);
    expect(() => loadDeskConfig({DESK_MAX_LEVERAGE:"3"})).toThrow();
    expect(() => loadDeskConfig({...demo,DELTA_ENV:"production"})).toThrow();
    expect(() => loadDeskConfig({...demo,DESK_DEMO_MODE:"true"})).toThrow();
    expect(() => loadDeskConfig({DESK_EXECUTION:"delta",DELTA_API_SECRET:"unused"})).toThrow();
    expect(() => new DeltaBridge({environment:"production",apiKey:"",apiSecret:""})).toThrow(/testnet/);
  });
  it("starts unarmed even with opt-in, requires explicit candidate, fails closed on health/kill/selection changes", async () => {
    const {desk,fetcher} = fixture();
    expect(desk.snapshot()).toMatchObject({execution:"disabled", strategy_id:null, kpis:{balance:null, equity:null,win_rate:null}});
    expect(await desk.setMode({execution:"delta"})).toMatchObject({ok:false});
    expect(fetcher).not.toHaveBeenCalled();
    expect(desk.selectStrategy("invalid").ok).toBe(false);
    expect(desk.selectStrategy("channel-6").ok).toBe(true);
    expect((await desk.setMode({execution:"delta"})).ok).toBe(true);
    expect(desk.execution).toBe("delta");
    desk.selectStrategy("sweep-6");
    expect(desk.execution).toBe("disabled");
    expect((await desk.setMode({execution:"delta"})).ok).toBe(true);
    await desk.engageKillSwitch(true,true);
    expect(desk.execution).toBe("disabled");
    expect((await desk.setMode({execution:"delta"})).ok).toBe(false);
    expect(fetcher.mock.calls.every(([,o]) => o?.method === "GET")).toBe(true);
  });
  it("never arms via API alone or with pending, unknown, manual exposure or malformed account data", async () => {
    const {desk,db,replies} = fixture();
    const observe = fixture({...demo,DESK_EXECUTION:"disabled"}).desk;
    observe.selectStrategy("channel-6");
    expect((await observe.setMode({execution:"delta"})).ok).toBe(false);
    desk.selectStrategy("channel-6");
    replies["/v2/orders"] = [{id:1}];
    expect((await desk.setMode({execution:"delta"})).ok).toBe(false);
    replies["/v2/orders"] = [];
    replies["/v2/positions/margined"] = [{size:"1",product_symbol:"SOLUSD",product_id:9,entry_price:"10",mark_price:"11",unrealized_pnl:"1"}];
    expect((await desk.setMode({execution:"delta"})).ok).toBe(false);
    expect(desk.accountSnapshot()).toMatchObject({equity:121,positions:[{instrument:"SOLUSD"}]});
    replies["/v2/positions/margined"] = [{size:null}];
    expect((await desk.setMode({execution:"delta"})).ok).toBe(false);
    expect(desk.kpis().equity).toBeNull();
    expect(db.claimSignal("x",{})).toBe(true);
    expect(db.claimSignal("y",{})).toBe(false);
    db.finishSignal("x","unknown","timeout",null,null);
    expect(db.claimSignal("y",{})).toBe(false);
    replies["/v2/positions/margined"] = [];
    expect((await desk.setMode({execution:"delta"})).ok).toBe(false);
  });
  it("invalidates in-flight arming on pause and preserves the UTC drawdown baseline on re-arm", async () => {
    const {desk,replies} = fixture();
    desk.selectStrategy("channel-6");
    const pending = desk.setMode({execution:"delta"});
    desk.paused = true;
    expect((await pending).ok).toBe(false);
    desk.paused = false;
    expect((await desk.setMode({execution:"delta"})).ok).toBe(true);
    replies["/v2/wallet/balances"] = [{asset_symbol:"USD",balance:"100",available_balance:"100"}];
    await desk.syncDelta();
    expect(desk.execution).toBe("disabled");
    expect((await desk.setMode({execution:"delta"})).ok).toBe(false);
    expect(desk.kpis().drawdown_pct).toBeCloseTo(100/6);
  });
  it("evaluates selected candidate from closed exchange bars only; forming updates do not cause signals", async () => {
    const {desk,db,stream,fetcher} = fixture();
    desk.selectStrategy("channel-6");
    await desk.start();
    expect(db.decisions(3)).toMatchObject([{signal_id:`channel-6:BTCUSD:${last()}`,outcome:"skipped"}]);
    stream.emit("candle",{symbol:"BTCUSD", timeframe:"5m", candle:{timestamp:(last()+300)*1000,open:104,high:106,low:103,close:106,volume:2}});
    expect(desk.chartBars("BTCUSD",1)[0]?.close).toBe(106);
    expect(desk.bars("BTCUSD",1)[0]?.close).toBe(104);
    expect(desk.cycles).toBe(1);
    expect(fetcher.mock.calls.every(([,o]) => o?.method === "GET")).toBe(true);
  });
  it("rejects malformed or missing quotes rather than fabricating a zero spread", async () => {
    const {desk,replies} = fixture();
    for (const quotes of [{},{best_bid:102,best_ask:100}]) {
      replies["/v2/tickers/BTCUSD"] = {mark_price:101, quotes};
      await expect(desk.delta.ticker("BTCUSD")).rejects.toThrow("quote");
    }
  });
  it("disarms and quarantines an ambiguous submission; fixture records the plan without sending it", async () => {
    let ms = Math.floor(Date.now()/300_000)*300_000 + 5_000;
    vi.spyOn(Date,"now").mockImplementation(() => ms);
    const {desk,db,replies,fetcher} = fixture();
    const recorder = vi.spyOn(desk.delta,"placeEntry").mockResolvedValue({ok:false,symbol:"BTCUSD",message:"Unconfirmed"});
    desk.selectStrategy("channel-6");
    expect((await desk.setMode({execution:"delta"})).ok).toBe(true);
    ms += 300_000;
    replies["/v2/tickers/BTCUSD"] = {symbol:"BTCUSD",timestamp:ms*1000,mark_price:104,quotes:{best_bid:103.99,best_ask:104}};
    replies["/v2/history/candles"] = bars();
    await desk.start();
    expect(recorder).toHaveBeenCalledOnce();
    expect(recorder.mock.calls[0]?.[0]).toMatchObject({symbol:"BTCUSD",direction:"LONG",limit:104,stop:103,target:106});
    expect(fetcher.mock.calls.every(([,o]) => o?.method === "GET")).toBe(true);
    expect(desk.execution).toBe("disabled");
    expect(db.hasUnresolvedOrder()).toBe(true);
    expect((await desk.setMode({execution:"delta"})).ok).toBe(false);
  });
  it("continues armed demo scanning but never adds exposure until Delta reports a flat account", async () => {
    let ms = Math.floor(Date.now()/300_000)*300_000 + 5_000;
    vi.spyOn(Date,"now").mockImplementation(() => ms);
    const {desk,replies} = fixture();
    const place = vi.spyOn(desk.delta,"placeEntry").mockResolvedValue({
      ok:true,symbol:"BTCUSD",message:"Demo fill verified",orderId:"demo-1",price:104,contracts:1
    });
    desk.selectStrategy("channel-6");
    expect((await desk.setMode({execution:"delta"})).ok).toBe(true);

    const advanceBar = async () => {
      ms += 300_000;
      replies["/v2/tickers/BTCUSD"] = {symbol:"BTCUSD",timestamp:ms*1000,mark_price:"104",quotes:{best_bid:"103.99",best_ask:"104"}};
      replies["/v2/history/candles"] = bars();
      await desk.refreshHealth();
    };
    await advanceBar();
    await desk.start();
    expect(place).toHaveBeenCalledOnce();
    expect(desk.execution).toBe("delta");

    replies["/v2/positions/margined"] = [{size:"1",product_symbol:"BTCUSD",product_id:84,entry_price:"104",mark_price:"104",unrealized_pnl:"0"}];
    await advanceBar();
    await desk.poll();
    expect(place).toHaveBeenCalledOnce();
    expect(desk.execution).toBe("delta");

    replies["/v2/positions/margined"] = [];
    ms += desk.rules.cooldown_minutes * 60_000;
    await desk.syncDelta();
    await advanceBar();
    await desk.poll();
    expect(place).toHaveBeenCalledTimes(2);
    expect(desk.execution).toBe("delta");
  });
  it("planned risk includes both fees including GST, round-trip slippage, observed spread and product multiplier", () => {
    expect(bracketPrices(100,"short")).toEqual({stop:101,target:98});
    expect(budgetedLossPerContract(100,99,.1,0,.03)).toBeCloseTo(.1188);
    expect(budgetedLossPerContract(100,99,.1,8,.03)).toBeGreaterThan(.1188);
  });
  it("retains pre-migration rows outside the active journal and leaves new records intact on reboot", () => {
    const path = `.desk-migration-test-${randomUUID()}.sqlite`;
    disposers.push(() => { for (const suffix of ["","-wal","-shm"]) rmSync(path+suffix,{force:true}); });
    const old = new Database(path);
    old.exec("CREATE TABLE decisions (summary TEXT); INSERT INTO decisions VALUES ('simulated'); CREATE TABLE kv (key TEXT, value TEXT); INSERT INTO kv VALUES ('managed','{}')");
    old.close();
    const migrated = new DeskDatabase(path);
    expect(migrated.decisions()).toEqual([]);
    expect(migrated.db.prepare("SELECT summary FROM legacy_unverified_decisions").get()).toEqual({summary:"simulated"});
    expect(migrated.kvGet("managed",null)).toBeNull();
    migrated.logDecision("BTCUSD","new","skipped","observation",[]);
    migrated.close();
    const rebooted = new DeskDatabase(path);
    try { expect(rebooted.decisions()).toMatchObject([{signal_id:"new"}]); } finally { rebooted.close(); }
  });
});
