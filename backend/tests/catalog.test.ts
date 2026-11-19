import { describe, expect, it } from "vitest";
import { evaluateCandidate, strategies } from "../src/desk/catalog.js";
import type { Bar } from "../src/desk/types.js";

describe("closed-candle strategy catalog", () => {
  const bar = (i: number, close = 100): Bar => ({ time: i * 300, open: close, close, high: close + 1, low: close - 1, volume: 5 });
  const history = Array.from({ length: 60 }, (_, i) => bar(i));
  it("offers at least 100 uniquely selectable candidates without warm-up signals", () => {
    expect(new Set(strategies.map(s => s.id)).size).toBeGreaterThanOrEqual(100);
    for (const { id, lookback } of strategies) expect(evaluateCandidate(id, history, lookback)).toBeNull();
  });
  it("uses only the selected prefix, detecting both sides of a channel without future candles", () => {
    const sequence = [...history, bar(60, 104), bar(61, 93)];
    expect(evaluateCandidate("channel-12", sequence, 60)).toBeNull();
    expect(evaluateCandidate("channel-12", sequence, 61)).toBe("long");
    expect(evaluateCandidate("channel-12", sequence, 62)).toBe("short");
    expect(() => evaluateCandidate("not-registered", sequence)).toThrow(/unknown strategy/i);
  });
});
