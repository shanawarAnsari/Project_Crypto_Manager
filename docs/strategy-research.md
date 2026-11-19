# Delta India strategy screen — 19 November 2026

**Decision: none of the candidates passed this initial consistency check.** Do not treat a selectable candidate as a recommendation to trade. No account credentials, production orders, or demo orders were used in this research.

## What was tested

We ran the same simulator that the Backtest tab calls on actual public Delta India BTCUSD and ETHUSD perpetual five-minute candles. Each symbol had two separate windows: March 1 to April 1 (selection) and October 1 to November 1, 2026 (holdout); all boundaries are UTC and ends exclusive. Each window had 8,928 validated candles. Rankings used March only. We did not refit after seeing October. A holdout used for selection in future work is no longer untouched.

The [catalog](../backend/src/desk/catalog.ts) contains 12 entry hypotheses, each tested with 6, 8, 10, 12, 16, 20, 24, 32, and 48 prior bars. These are **108 executable configurations, not 108 independent edges**:

| Mechanism | Entry hypotheses |
|---|---|
| Continuation | Prior-channel breakout, volume-backed impulse, directional-efficiency momentum, volume-pressure continuation |
| Reversal | Failed channel breakout, volatility-band re-entry, expansion exhaustion, range-edge wick rejection |
| Trend resumption | Pullback through the mean followed by recovery, volume-weighted mean reclaim |
| Volatility transition | Inside-bar trend breakout, compressed-range release |

Signals observe only closed bars. The simulator enters at the next open, models one unlevered position, targets 2% with a 1% stop, applies adverse execution on opening gaps through stops and assumes the stop was hit first when a candle contains both exits. Each window starts at 10,000 simulated USD; any remaining position exits at the end. Costs: 5.9 basis points of notional per side for fee plus GST, 2 bps per side of slippage, and a 1 bp full bid/ask spread. No maker rebate or promotional closing-fee discount. Approximate round-trip friction is **16.8 bps before funding**.

## Results after modeled costs

| Symbol | Positive in March | Positive in October | Positive in both | Highest March return | Same candidate in October |
|---|---:|---:|---:|---|---|
| BTCUSD | 2/108 | 15/108 | **0/108** | `pullback-20`: +6.75%, 45 trades | **−12.09%**, 30 trades, 16.14% max drawdown |
| ETHUSD | 4/108 | 27/108 | **0/108** | `envelope-48`: +7.42%, 114 trades | **−11.75%**, 65 trades, 15.93% max drawdown |

Even the best selection-month results reversed on the holdout. This does not establish that no crypto strategy can work. It does establish that this screen gives no basis to label any candidate a consistent winner. Historical OHLCV does not establish intra-bar fill order, depth, funding, contract rounding or demo fill quality. Simulated returns do not include the demo desk's additional entry vetoes and risk sizing.

To reproduce the screen from the repository root (no API key): `pnpm --dir backend exec tsx scripts/screen-catalog.ts`. The output includes all 432 symbol/window/candidate rows. A rerun may change if the exchange revises its archive. The Lab accepts up to five years, **not five guaranteed years per contract**: the [BTCUSD product](https://api.india.delta.exchange/v2/products/BTCUSD) lists a December 2023 launch. A December 2021 five-minute probe returned zero bars; the lab rejects missing history rather than substituting another venue or series.

## Sources and next decision

- [Wen et al., *Intraday Return Predictability in the Cryptocurrency Markets: Momentum, Reversal, or Both*](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4080253): liquidity and market regime affect intraday momentum and reversal. Motivation for competing hypotheses, not evidence that these exact signals earn profits on Delta.
- [Bailey et al., *The Probability of Backtest Overfitting*](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf): trying many related variants can produce an impressive historical winner by chance. Reporting all candidates and the selection winner's later result makes that failure visible.
- [Delta India product metadata](https://api.india.delta.exchange/v2/products/BTCUSD) and [fee schedule](https://www.delta.exchange/fees): BTCUSD advertised a 0.0005 taker rate, and the published India schedule adds 18% GST to trading fees. Actual tiers and spreads can differ; stress higher costs in the Lab.

Before any strategy is promoted beyond experimentation, lock its rules and risk limits, test multiple non-overlapping unseen periods, stress costs, compare against staying flat, and reconcile forward demo fills and fees against predictions. Two months on two correlated symbols are insufficient evidence of an edge. A stop caps planned risk, not realized loss during gaps or outages.
