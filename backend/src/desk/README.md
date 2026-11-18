# Liquidity Sweep Desk (default app)

A seven-agent trading desk that trades the **Liquidity Sweep** (stop-hunt reversal) strategy on
**Delta Exchange India** perpetuals. It runs on every closed 5M candle.

```
Scout → Cartographer → Hunter → Analyst (LLM) → Guardian (AEGIS) → Executioner → Chronicler
data    liquidity map   sweep    strict JSON     hard vetoes        paper | Delta  SQLite journal
```

Every agent implements `run(ctx)` and returns an `AgentResult`; `orchestrator.ts` streams every result over
`/api/ws`. One agent failing never crashes the desk.

## Strategy (Hunter + AEGIS), crypto thresholds

- **Levels:** previous-day high/low, Asian range (00–07 UTC), last 3 4H swing highs/lows, equal highs/lows (15M clusters within 0.05%).
- **Sweep:** wick pierces the level by 0.15–0.40% from inside the range (no touch in the 7 prior bars).
- **Displacement:** close back inside within 3 candles, body ≥ 1.2× the 20-candle average body (volume spike = bonus).
- **Exits:** entry on the confirmation close; SL beyond the wick + 0.10%; TP1 at 1:2; TP2 at the next liquidity pool ≥ 1:3.
- **Management:** break-even at 1R, 50% partial at TP1, trailing stop (1R behind price) toward TP2.
- **AEGIS vetoes:** kill switch, Analyst NO_TRADE, spread %, 4% daily drawdown kill, max open trades (one per symbol),
  RR ≥ 1:2, confidence ≥ 7, news hours, duplicate/cooldown, contract sizing (1% risk, 2% max), margin.

The scanner runs continuously while the backend is running; crypto has no market close. `OFF_HOURS` is only the
21:00-00:00 UTC session label. Session names are context only for supported crypto instruments and never block entries.

The Analyst may only refine or reject: entry/SL are pinned to the Hunter's numbers and targets are clamped to the
candidate range. It uses any OpenAI-compatible endpoint (`ANALYST_*`, falling back to `NVIDIA_*`); invalid JSON is
retried once and then becomes `NO_TRADE`; network errors fall back to the deterministic rule-based scorer.

## Modes

| Market data | Execution | Pill |
|---|---|---|
| Demo (synthetic market with planted sweeps, one candle every `DESK_DEMO_CYCLE_SECONDS`) | Paper | DEMO |
| Delta India live 5M candles | Paper | PAPER |
| Delta India live 5M candles | Delta orders, `DELTA_ENV=testnet` | DELTA DEMO |
| Delta India live 5M candles | Delta orders, `DELTA_ENV=production` | DELTA LIVE |

`DESK_EXECUTION` defaults to `paper`. Set it to `delta` only with `DELTA_ENV=testnet`, a complete Demo credential
pair, and `DESK_DEMO_MODE=false` to enable Demo exchange orders on startup. It is rejected with synthetic data or
production configuration; production order execution remains available only through the explicit live unlock.
An order is submitted only when a fresh Delta signal passes the existing risk and account checks.

Delta orders are market entries with an exchange-side bracket (SL + TP2, mark-price trigger), so a position is never
unprotected. Break-even/trailing edits move the bracket stop; TP1 partials are reduce-only market orders. Each
`signal_id` can create at most one order (SQLite claim). Real-money orders additionally need
`LIVE_TRADING_CONFIRMED=I_UNDERSTAND_REAL_MONEY` **and** typing `I UNDERSTAND THE RISK` in Settings each session.
Live Delta market data is the default (`DESK_DEMO_MODE=false`); synthetic candles require explicit opt-in.
The reconnecting India WebSocket updates forming 5M candles and mark prices for every configured instrument.
REST polling reconciles closed candles and runs the strategy only on closed bars. A failed connection retains
the selected source and retries: it never replaces exchange data with synthetic data or switches execution venues.
After a market-socket reconnect, REST history is reloaded to fill gaps before the next strategy cycle.

The main live-data dashboard shows the selected **exchange account's** wallet, available margin and all open
positions, independently of the paper/order execution setting. These are read-only account requests; reading
the Live account does not unlock trading. Account refreshes run every three seconds, including while paused.
Missing or failed authentication is shown as unavailable, not as the paper engine's starting balance. Last-received
account and quote data are marked stale after 15 seconds or when the desk socket disconnects. Paper performance,
strategy journals and backtests are local simulations/desk records, not an imported exchange performance history.
Open P/L uses the exchange-supplied value when available; the nested margined-position format is valued
from the exchange's entry, signed size, contract value and current mark. Equity is balance plus open P/L,
not an imported daily-performance statistic.

`DELTA_ENV=testnet` selects the Demo account and its prices; `production` selects Live. Use the matching
`DELTA_DEMO_API_KEY` / `DELTA_DEMO_API_SECRET` or `DELTA_LIVE_API_KEY` / `DELTA_LIVE_API_SECRET` pair.
Legacy `DELTA_API_KEY` / `DELTA_API_SECRET` are used only when **none** of the scoped credentials are set.
Pairs are never mixed across scopes or environments. Restart after changing account configuration.
Only one account is active at a time; the UI names that account explicitly.
Delta API keys are IP-whitelisted, so `DELTA_IP_FAMILY=4` (default) pins outbound connections to IPv4; dual-stack
hosts would otherwise egress over IPv6 and get `ip_not_whitelisted_for_api_key` (reported as `IP_NOT_WHITELISTED` with the rejected IP).

## Files

`agents.ts` (seven agents + daily review) · `strategy.ts` (Cartographer/Hunter rules) · `risk.ts` (AEGIS) ·
`analyst.ts` (LLM + guardrails) · `paper-engine.ts` · `demo-feed.ts` · `delta-bridge.ts` (Delta India REST) ·
`backtest.ts` (same rules on synthetic or real Delta history) · `db.ts` · `orchestrator.ts` · `api.ts` · `config.ts`.
Entry point: `src/desk-server.ts`.
