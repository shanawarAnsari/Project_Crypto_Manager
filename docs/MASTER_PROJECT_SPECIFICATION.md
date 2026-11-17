# Sunny Crypto Manager — Master Project Specification

Current behavior is defined by the **Owner-approved Demo chat agent (2026-11-17)** amendment below.
It supersedes earlier strategy-deck, hourly-only automation, AI-config-only and Demo 2% descriptions.
Production agent execution is not enabled. Retained deterministic APIs are compatibility surfaces only.

### Owner-approved Demo execution test (2026-11-17)

Provide a two-step test-entry control, separate from chat and scheduled signals. Preview performs
read-only exchange/risk checks and returns a one-use, 30-second confirmation token plus the proposed
BTCUSD side, one whole contract, 1x leverage and tick-aligned stop/target. The operator selects BUY
or SELL; initial stop/target distances are 1%/2% for this plumbing test, not a strategy recommendation.
Only explicit confirmation may submit. Refresh account, product, fees and price and obtain a fresh
RiskApproval at confirmation; never enlarge beyond one contract or relax any existing limit.
Require an explicitly started, unlocked Demo bot, no existing exposure/orders/unresolved submission,
and unchanged controls. Reject Live, expired/reused tokens, insufficient margin/budget and unsafe brackets.
Use the normal execution, durable ownership, attempt counting and read-back path; unknown submissions
halt without retry. A confirmed test entry remains agent-owned and is monitored normally, not
automatically closed. Preview/cancel must never place orders. No exchange order is part of development verification.
Display confirmed entry, exchange-verified stop and target as chart price lines and show each open
position's exchange-reported unrealized PnL beside the chart (USD, excluding any claim of net realized
profit). Refresh account/PnL every five seconds; hide position overlays/PnL on unavailable telemetry.
Do not invent protection from a proposal: for owned trades, use authenticated exact-order/position
read-back when the position endpoint omits bracket prices. Missing/mismatched protection is an
explicit account/verification error, never a confirmed protected fill.

## Purpose and status

Sunny Crypto Manager is a risk-first BTC strategy dashboard for Delta Exchange India. This repository delivers a local Docker Compose MVP. It connects to the owner's Delta India account (`DELTA_ENV=production`) or to Demo/testnet (`DELTA_ENV=testnet`, default). When an operator explicitly enables the bot, eligible strategy signals are submitted autonomously after per-order risk approval. Owner decision 2026-11-17: real-money production trading from the laptop is permitted, BTCUSD only for the MVP, max 2x leverage, daily loss cap 2% of capital.

## System boundaries

Owner dashboard/leverage decision 2026-11-17: retain Wallet portfolio (indicative) and USD trading wallet cards; remove the Wallet Holdings panel and the successful live-account verification sentence. Keep unavailable-account and portfolio errors visible. Leverage has a system-wide hard maximum of 2x, not a mandatory 2x setting; lower operator/AI limits remain valid. Configuration above 2x is rejected, legacy persisted limits above 2x are reduced on initialization with automation paused, and risk/execution independently enforce the ceiling. Display the configured leverage cap separately from actual position leverage.

Dashboard KPI layout: keep all eight account telemetry cards in a single row, reduce label/value typography to fit, allow long values to wrap rather than truncate, and horizontally scroll the row on narrower viewports.

Trading overview presentation: make the indicative portfolio total the visual lead and show its USD and INR amounts on separate lines; present the USD wallet and available margin with their INR equivalents as secondary values. Distinguish testnet/verification context from automation readiness with separate informational, paused, enabled, and blocked status treatments. Preserve all account, portfolio, and trading-readiness errors and never imply account verification from environment selection or credentials.

- The backend owns persistence, exchange connectivity, market-data normalization, strategy evaluation, AI routing, risk decisions, and execution.
- The frontend is a dashboard client. It cannot call the exchange directly or make risk decisions.
- Money and quantities use decimal-safe representations; JavaScript floating-point arithmetic must not be used for account or order calculations.
- State-changing exchange order operations belong only to the execution boundary and require a typed `RiskApproval`.
- Fail closed on missing risk inputs, stale market data, invalid AI output, configuration errors, or exchange errors.
- Never log credentials, request signatures, or authorization headers.
- Use only Delta Exchange India endpoints. Never use Delta Global.


## Stack

- Node.js 24 LTS, TypeScript strict mode, pnpm workspaces, and Turborepo.
- Express backend, SQLite via `better-sqlite3` with WAL, and persisted data at `./data/bot.sqlite`.
- React + Vite + Tailwind frontend and `lightweight-charts`.
- Vitest for tests; Docker Compose for local orchestration.
- Delta India REST and websocket APIs; NVIDIA NIM OpenAI-compatible API with Zod validation; `technicalindicators`.
- NVIDIA NIM defaults to `nvidia/nemotron-3.5-bolt-e4b`; its API key is supplied through environment variables and responses are validated as strict JSON before use.

## MVP behavior

### Owner-approved Demo chat agent (2026-11-17)

Replace the strategy deck with a persistent NVIDIA chat and a live, resumable activity feed.
Show observable steps and concise decision summaries, never private model reasoning.
Each chat/review displays the complete validated LLM decision (action, summary and all proposed
entry fields), distinct from system context, risk, submission and exchange-confirmation updates.
There is one LLM call per chat/review, not an LLM response at every deterministic stage.
Never display unvalidated provider output or claim a submission acknowledgement is a confirmed fill.
One selector controls closed-candle timeframe and review cadence (1m/5m/15m/30m/1h; default 5m).
The agent proposes wait, open long/short, hold, or close its own position; only execution acts,
after independent risk approval. The legacy deterministic worker must not place competing orders.
Chat itself never enables trading or submits an order. Start remains explicit and restart pauses.
This new agent is Demo-only; production agent execution is prohibited.

Owner risk amendment: allocate at most 25% of verified USD trading equity as margin, additionally
bounded by available margin. Leverage is at most 2x and respects lower persisted limits.
Planned stop loss plus estimated round-trip taker fees (including tax) must fit within 5% of
allocated margin. At most five entry attempts per UTC day; uncertain submissions count and block
further trading until reconciled. The Demo daily loss limit is 10% of start-of-day USD capital,
still bounded by MAX_DAILY_LOSS; realized ledger PnL already includes commissions, rebates,
funding and liquidation charges, and unrealized PnL is included once. Production retains its
existing policy. Never use indicative portfolio valuations to size trades.

The USD wallet balance excludes unrealized PnL: derive start-of-day capital from wallet balance minus
today's realized ledger PnL, not minus unrealized PnL again. Include realized plus unrealized PnL once
in the daily breaker. A legacy DAILY_LOSS_PERCENT=2 does not override the approved Demo 10% policy.

Use verified product fee rates plus the India fee tax multiplier; reject missing/invalid fee data.
Planned loss is not a guaranteed maximum: gaps, funding and slippage may exceed it.
Persist the proposal, order identity, execution status and trade thesis. Reconcile exact entry
order fills and product exposure before claiming ownership, closing, or allowing another entry.
Never adopt an external position. Unknown submissions and ownership mismatches fail closed.
Close orders must be reduce-only, risk-approved, idempotent and verified through exchange read-back.

The backend exposes a health endpoint, a dashboard snapshot, SQLite-backed candles for `1h`, `4h`, `1d`, and `1w`, strategy configuration, bot pause/resume, an emergency halt, and an advisory strategy-signal preview. The worker uses market data from the Delta India environment selected by `DELTA_ENV` and performs periodic AI evaluations. AI may configure the strategy within operator risk caps; deterministic strategies generate trade signals. With the bot explicitly enabled, eligible signals are submitted automatically only after fresh risk approval. Production requires the separate real-money confirmation. The UI presents the selected environment, risk/account telemetry, a multi-timeframe chart, strategy controls, and activity/audit tabs.

Strategies are deterministic and separate from AI configuration: mean reversion (RSI plus Bollinger Bands), trend breakout (multi-timeframe EMA, ADX and ATR stop sizing), grid scalping, and flat. AI output is untrusted configuration and cannot exceed risk limits, directly create an order, or bypass a successful risk approval.

The strategy control in the dashboard provides a dropdown for all four strategies (Mean reversion, Trend breakout, Grid scalping, and Flat/no entries). Operators apply the selected strategy explicitly; changing the selection alone does not persist it.

The UTC daily-loss circuit breaker includes realized and mark-to-market unrealized PnL, disables execution, and records the local halt. Realized PnL is reconciled from the selected account's USD wallet transaction ledger for the current UTC day, using the documented microsecond time bounds and complete cursor pagination; current exchange positions provide unrealized PnL. The ledger amount is kept in its native wallet unit and compared with the risk cap in that same unit. Missing, malformed, incomplete, or unsupported ledger data fails closed; risk-core has no local trade-history or estimated-PnL fallback. Account telemetry is available only when balances, positions, open orders, and the daily ledger reconcile successfully. A strategy preview is advisory. When the operator enables the bot, each eligible signal must trigger a fresh account/PnL reconciliation and obtain a fresh RiskApproval before automatic submission. The bot starts paused after process restart and requires explicit operator re-enablement; persisted state must never silently resume automated trading. Emergency order cancellation and product-scoped reduce-only position closes are reported as successful only after exchange read-back confirms there are no remaining open orders or positions for the configured product.

## Persistence

SQLite tables include a singleton bot state, timeframe candles keyed by symbol/timeframe/timestamp, trade records, and AI decision audits. Database writes use prepared statements and transactions for related state changes. WAL is enabled on database initialization. Account equity and PnL come from reconciled exchange telemetry; missing exchange telemetry is never filled with estimates.

## API contract

The dashboard reports the selected environment separately from verified account connectivity and `executionConfigured` (credentials plus any required trading confirmation). Read-only account reconciliation requires credentials, not trading confirmation. The UI must never claim an account is connected based on configuration alone, display unavailable account balances, or offer bot enablement while telemetry is unavailable or a risk lock is active. Missing environment selection remains testnet and must be clearly identified, never relabeled LIVE.

Owner balance-display decision 2026-11-17: show total wallet portfolio value separately from the USD trading wallet balance and available margin. Individual nonzero holdings remain in the API, but the Wallet Holdings UI panel is removed. Sum Delta's own `balance_inr` wallet valuations with decimal math, then derive indicative USD equivalents using the adapter's display conversion rate. Do not substitute derivative ticker prices for the exchange's wallet valuation. Missing or invalid valuations make the entire portfolio valuation explicitly unavailable, never a partial total. This display-only valuation excludes position unrealized PnL and must never increase trading collateral, risk sizing, or loss limits. The legacy API `account.equity` remains the USD wallet balance; the UI labels it accordingly.

- `GET /api/health`: liveness/readiness status suitable for container health checks.
- `GET /api/dashboard`: account/market snapshot, bot state, positions/orders, recent trades, and AI audits. Unavailable exchange or AI data is represented explicitly as unavailable rather than fabricated.
- `GET /api/signal/preview`: evaluates the configured deterministic strategy against fresh, closed candles and returns a signal preview. It never authorizes or submits an order.
- `GET /api/candles?tf=1m|5m|15m|30m|1h|4h|1d|1w&limit=N`: chronological candle data (limit capped at 1000). Candles are sourced from the Delta India environment selected by `DELTA_ENV` using its configured `candlestick_<tf>` websocket. The worker persists each validated candle and relays it over IPC to the API process, which pushes it to dashboard clients on the server-to-client WebSocket `GET /api/stream?tf=<timeframe>` (`{type:"candle",timeframe,candle:{time,open,high,low,close,volume}}`; invalid `tf` is rejected with 400). Intraday timeframes (1m, 5m, 15m, 30m) are display-only; strategy evaluation and AI reevaluation accept only 1h/4h/1d/1w.
- `POST /api/strategy`: validated user instruction, strategy override, and risk configuration updates.
- `POST /api/bot/toggle`: explicitly enables or pauses automated signal evaluation and execution in the selected environment. Production additionally requires explicit live-trading confirmation. Enabling does not bypass fresh risk approval for each order; the bot remains paused after restart until explicitly enabled again.
- `POST /api/kill-switch`: disables the bot and attempts configured cancellation and product-scoped reduce-only position safety actions; reports each action as succeeded only after exchange read-back confirms completion.

## Safety and operational requirements

- The application connects only to the fixed Delta India endpoints selected by `DELTA_ENV` (`production` or `testnet`, default `testnet`); no other host, including Delta Global, can be configured. Production orders additionally require `LIVE_TRADING_CONFIRMED=I_UNDERSTAND_REAL_MONEY`. Missing credentials or unavailable account data disables trading and never falls back to local or estimated account values.
- `DELTA_ENV=testnet` selects `DELTA_DEMO_API_KEY` / `DELTA_DEMO_API_SECRET`; `DELTA_ENV=production` selects `DELTA_LIVE_API_KEY` / `DELTA_LIVE_API_SECRET`. Demo credentials are never sent to Live endpoints or vice versa. Legacy `DELTA_API_KEY` / `DELTA_API_SECRET` are used only when all four environment-specific credential variables are empty. Docker Compose passes both credential pairs to the backend; changing `DELTA_ENV` requires recreating the backend, and automation remains paused after restart.
- After explicit operator enablement, trade signals are submitted automatically without per-trade confirmation. The bot must start paused after every process restart. Every order requires fresh UTC daily PnL reconciliation from the wallet ledger plus current all-position unrealized PnL, and a valid `RiskApproval`. Every entry order uses an idempotent client order ID and exchange-side stop protection (`bracket_stop_loss_price` with `mark_price` trigger, plus take-profit) and is submitted only by the execution boundary. Approved base-unit quantity is converted to whole contracts via the product `contract_value`; bracket prices are snapped to `tick_size`.
- Product IDs are environment-specific (`27` for production and `84` for Demo defaults). Before order placement, resolve `BTCUSD` through the documented product-by-symbol endpoint and verify the returned ID, symbol, live state, and operational trading status. Any mismatch fails closed; `DELTA_PRODUCT_ID` is only an explicit override and does not bypass those checks.
- Read the active orders with the documented `product_ids` and `states` filters and follow every `meta.after` cursor. Wallet and open-order pagination is complete only when the response explicitly includes a null `after` cursor. Missing pagination metadata or a repeated/invalid cursor fails closed.
- The exchange's documented close-all-positions endpoint is account-wide and requires a user ID; do not use it for the BTC-only approval. Close only configured-product positions with market orders marked `reduce_only=true`, then verify open orders and positions through authenticated read-back. If verification is unavailable or shows remaining exposure, surface an unconfirmed/failed action; the local kill switch remains latched.
- Leverage is clamped to the lower of the approved AI/config value and the persisted operator cap (default 2x).
- The daily loss cap is `DAILY_LOSS_PERCENT` (default 2) of start-of-day capital, never above `MAX_DAILY_LOSS`.
- The daily-loss breaker is independent of AI advice and requires an explicit manual reset.
- Strategy signals are evaluated from closed hourly candles, at most once per candle. Incomplete hourly candles are not used to authorize entries.
- The kill switch is always available to pause the local worker, even when the exchange is unreachable.
- Credentials are supplied through environment variables and excluded from version control.

## Verification

The deliverable must provide workspace scripts for build, lint, typecheck, and tests, plus focused tests for persistence, validation, risk gating, and key frontend actions. Verify automated Demo orders require explicit bot enablement and fresh per-order risk approval, the bot remains paused after restart, environment-specific BTCUSD product selection fails closed on mismatch, and emergency actions are verified after exchange read-back. Docker Compose must use the backend health check before starting the frontend and persist SQLite data under `./data`.

## Decisions

The greenfield scope is based on the user-provided implementation request because the prior source documents and code were deleted. The safety rules in this specification remain mandatory. Owner decision 2026-11-17 supersedes the earlier "Demo only / live forbidden on the laptop" rule: live production execution from the laptop (static IP, 24x7) is permitted via `DELTA_ENV=production` plus explicit `LIVE_TRADING_CONFIRMED`, BTCUSD only.
