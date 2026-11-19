export const MIN_FEE_BPS = 5.9;
export const MIN_SLIPPAGE_BPS = 2;

/** Lab uses the simulated fill; demo uses the executable limit before rounding to the product tick. */
export function bracketPrices(entry: number, direction: "long" | "short") {
  const sign = direction === "long" ? 1 : -1;
  return { stop: entry * (1 - sign * 0.01), target: entry * (1 + sign * 0.02) };
}

/** Reserve both legs' taker fees including GST, slippage and one full observed spread. Not a guaranteed loss cap. */
export function budgetedLossPerContract(entry: number, stop: number, contractValue: number, feeBps: number, spreadPct: number) {
  const reference = Math.max(entry, stop);
  const roundTripPct = 2 * (Math.max(MIN_FEE_BPS, feeBps) + MIN_SLIPPAGE_BPS) / 10_000 + spreadPct / 100;
  return contractValue * (Math.abs(entry - stop) + reference * roundTripPct);
}
