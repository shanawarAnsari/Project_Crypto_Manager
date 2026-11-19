// Regression checks for standalone rule libraries (not a synthetic runtime or order path).
import { describe, expect, it } from "vitest";
import { clampToCandidate, mockDecision, parseDecision } from "../src/desk/analyst.js";
import { specFor } from "../src/desk/market.js";
import { contractSize, DEFAULT_RULES, evaluate, newGuardianState, type EvaluateInput } from "../src/desk/risk.js";
import { DEFAULT_PARAMS, detectAt, mapLiquidity } from "../src/desk/strategy.js";
import type { Bar, LiquidityLevel, Setup } from "../src/desk/types.js";

const T0 = 1_790_000_000 - (1_790_000_000 % 300);
function sweepSeries(sweepHigh: number): Bar[] {
  const bars: Bar[] = [];
  for (let k = 0; k < 38; k++) {
    const up = k % 2 === 0;
    bars.push({ time: T0+k*300, open: up ? 100 : 100.05, high:100.1, low:99.9, close:up ? 100.05 : 100, volume:10 });
  }
  bars.push({time:T0+38*300,open:100.2,high:sweepHigh,low:100.15,close:100.3,volume:40});
  bars.push({time:T0+39*300,open:100.3,high:100.35,low:99.75,close:99.8,volume:30});
  return bars;
}
const level: LiquidityLevel = { name:"PDH", price:100.5, side:"high", strength:2 };
describe("standalone sweep and Analyst guardrails", () => {
  const [setup] = detectAt(sweepSeries(100.701),39,[level],"SOLUSD",DEFAULT_PARAMS) as [Setup];
  it("detects bearish displacement and requires a sweep inside the configured depth window", () => {
    expect(setup).toMatchObject({direction:"SHORT",sweep_extreme:100.701,volume_spike:true});
    expect(setup.extension_depth).toBeCloseTo(.2,2);
    expect(setup.stop_loss).toBeGreaterThan(setup.sweep_extreme);
    expect((setup.entry_price-setup.take_profit_1)/(setup.stop_loss-setup.entry_price)).toBeCloseTo(2,2);
    for (const high of [100.55,101.5]) expect(detectAt(sweepSeries(high),39,[level],"SOLUSD",DEFAULT_PARAMS)).toEqual([]);
  });
  it("maps previous day high and low", () => {
    const start = T0 - (T0%86400) - 86400;
    const bars: Bar[] = Array.from({length:384},(_,i) => ({
      time:start+i*300,open:100,high:i<288?101:100.4,low:i<288?99:99.6,close:100,volume:1
    }));
    const names = mapLiquidity(bars).map(l => `${l.name}@${l.price}`);
    expect(names).toContain("PDH@101"); expect(names).toContain("PDL@99");
  });
  it("pins entry and stop, clamps targets and rejects contradictory JSON", () => {
    const d = mockDecision(setup);
    const tampered = {...d,trade_plan:{...d.trade_plan,entry_price:99,stop_loss:101.5,take_profit_2:setup.take_profit_2-10}};
    const {decision,notes} = clampToCandidate(tampered,setup);
    expect(decision.trade_plan).toMatchObject({entry_price:setup.entry_price,stop_loss:setup.stop_loss,take_profit_2:setup.take_profit_2});
    expect(notes.length).toBeGreaterThan(0);
    expect(clampToCandidate({...d,bias:"BULLISH_SWEEP_LONG"},setup).decision.bias).toBe("NO_TRADE");
    expect(() => parseDecision(JSON.stringify({...d,bias:"BULLISH_SWEEP_LONG",trade_plan:{
      entry_price:100,stop_loss:101,take_profit_1:102,take_profit_2:103,risk_reward_ratio:2
    }}))).toThrow();
  });
});
describe("standalone AEGIS sizing and vetoes", () => {
  const spec = {...specFor("SOLUSD"),contractValue:1};
  const base: EvaluateInput = {
    instrument:"SOLUSD",direction:"LONG",entry:100,stop:99,tp1:102,confidence:8,session:"LONDON",spreadPct:.01,
    equity:10000,availableMargin:10000,openTrades:0,instrumentHasPosition:false,signalId:"s1",levelKey:"SOLUSD:PDL",
    candleHourUtc:9,analystBias:"BULLISH_SWEEP_LONG",spec,now:1000
  };
  it("sizes whole contracts to budget, rejects insufficient margin, kill, and poor risk/reward", () => {
    expect(contractSize(10000,1,100,99,spec)).toEqual([100,100]);
    expect(contractSize(10,1,100,99,spec)).toEqual([0,0]);
    expect(evaluate(DEFAULT_RULES,newGuardianState(),base).checks.every(c => c.passed)).toBe(true);
    expect(evaluate(DEFAULT_RULES,{...newGuardianState(),kill_switch:true},base).checks.find(c => c.name==="Kill switch")?.passed).toBe(false);
    for (const change of [{tp1:101.5},{availableMargin:50}]) expect(evaluate(DEFAULT_RULES,newGuardianState(),{...base,...change}).checks.every(c => c.passed)).toBe(false);
  });
  it("tolerates rounding on 1:2 plans and treats crypto sessions as context in legacy rules", () => {
    const r = evaluate(DEFAULT_RULES,newGuardianState(),{...base,entry:94637,stop:95190.6,tp1:93529.9,direction:"SHORT",analystBias:"BEARISH_SWEEP_SHORT",spec:{...spec,contractValue:.001}});
    expect(r.checks.find(c => c.name==="Risk:Reward")?.passed).toBe(true);
    const overnight = evaluate({...DEFAULT_RULES,session_filter:true,allowed_sessions:["LONDON"]},newGuardianState(),{...base,session:"OFF_HOURS"});
    expect(overnight.checks.find(c => c.name==="Session")?.passed).toBe(true);
  });
});
