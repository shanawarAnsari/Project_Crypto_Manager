# Sunny Crypto Manager backend

## Liquidity Sweep Desk (default since 2026-11-19)

`pnpm dev` / `pnpm start` now run the seven-agent Liquidity Sweep desk (`src/desk-server.ts`, see
[src/desk/README.md](src/desk/README.md)). It binds `HOST` (default `127.0.0.1`) on `PORT` (4000) and stores its
journal in `DESK_DATABASE_PATH` (default `./data/desk.sqlite`). Desk settings:

| Variable | Default | Meaning |
|---|---|---|
| `DESK_INSTRUMENTS` | `BTCUSD,ETHUSD` | Delta India perpetual symbols to trade |
| `DESK_DEMO_MODE` | `false` | Live Delta feed and read-only account telemetry; `true` explicitly opts into synthetic data |
| `DESK_EXECUTION` | `paper` | `delta` submits risk-approved orders to the testnet Demo account; requires testnet, Delta credentials, and live market data |
| `DESK_DEMO_CYCLE_SECONDS` | `3` | Seconds per synthetic candle in Demo |
| `DESK_STARTING_BALANCE` | `10000` | Paper account balance (USD) |
| `DESK_MAX_LEVERAGE` | `25` | Upper bound for the leverage rule (production capped at 25) |
| `ANALYST_API_KEY` / `ANALYST_BASE_URL` / `ANALYST_MODEL` | NVIDIA values | Any OpenAI-compatible LLM; empty key = rule-based Analyst |

Delta credentials reuse `DELTA_ENV` and `DELTA_DEMO_API_*` / `DELTA_LIVE_API_*`. The legacy chat agent below
remains available via `pnpm dev:legacy`.

The default desk displays the selected Delta account's balance and positions even with paper execution.
WebSocket forming candles/mark prices update between 5M closes; strategy decisions use closed bars only.
Outages retain the selected source and mark last-received values stale rather than substituting demo data.
Only the selected environment's complete credential pair is used; account reads never unlock real-money orders.

## Legacy chat agent
Latest Demo policy revision (2026-11-18) supersedes older Demo numbers below: 100% USD-equity margin
including entry fees, 100x leverage ceiling (lower configured/saved/product caps preserved), planned
stop plus fees <=30% total USD equity, five UTC entry attempts, daily loss 50% bounded by MAX_DAILY_LOSS.
No upward saved-cap migration; default/configured 2x stays valid. Production/legacy remains 2x.
Test preview accepts integer leverage 1..100/default 1 and may narrow initial 1%/2% brackets to fit
equity/daily budgets before explicit confirmation. No guarantee against liquidation or excess loss.

## Current Demo chat workflow

The dashboard uses a persistent NVIDIA chat agent; the worker now supplies market data only.
Use `GET /api/agent`, `POST /api/agent/chat`, `POST /api/agent/settings` and the resumable SSE endpoint
`GET /api/agent/events`. Agent reviews default to closed 5m candles; select 1m/5m/15m/30m/1h.
Chat never enables trading or submits an immediate order. Explicit Start enables Demo-only scheduled
decisions; restart or timeframe changes pause automation. Production agent Start is rejected.
Legacy strategy editing and forced advice return 410 in the running agent app.

For signal-free Demo plumbing checks, the dashboard offers preview then explicit confirmation:
`POST /api/agent/test-entry/preview` with `{ "side": "buy" | "sell", "leverage"?: number }` (whole 1..100), followed by
`POST /api/agent/test-entry/confirm` with the returned `token` and
`"confirmation": "PLACE_DEMO_TEST_ORDER"`. One-use tokens expire after 30 seconds; restart or
control changes invalidate them. This uses one BTCUSD contract at selected 1..100x (default 1x),
initial 1% stop / 2% target narrowed if needed before preview,
fresh account/product/fee/price checks and normal risk/execution/ownership. All limits and Start
remain mandatory; production is rejected. Preview never submits. The test position is not automatically
closed. Dashboard-owned position brackets are verified against the exact entry order when displaying
stop/target; missing protection or ownership mismatch makes telemetry explicitly unavailable.

The panel also exposes `POST /api/agent/close-all` with
`{ "confirmation": "CLOSE_OWNED_DEMO_BTCUSD" }`: explicitly close only authenticated app-owned Demo
BTCUSD trades. The old confirmation literal is rejected. Drain agent work and invalidate stale
proposals, then use exact-size risk-approved reduce-only owned exits and authenticated close/flat
read-back. Never blanket-cancel orders or close external/manual exposure. No owned trade is a no-op;
mixed ownership or unresolved submissions fail closed. Success preserves running/paused/locked
controls; later signals may trade again. Start/reset/duplicates are blocked during closing.
Failure pauses and locks with no automatic retry. Production is rejected; no LLM is required.

Owner Demo policy is 100% maximum USD-equity margin (scheduled and test entries), 100x maximum leverage,
planned stop plus tax-inclusive fees <=30% total USD equity, five UTC entry attempts and 50% daily loss bounded by MAX_DAILY_LOSS.
Demo uses this 50% policy even if a legacy .env still says DAILY_LOSS_PERCENT=2; that variable continues
to control the legacy production policy. Never use multi-asset portfolio display totals for sizing.
See [AI module](src/ai/README.md) for lifecycle, limitations and local launch commands.
The older strategy descriptions below document retained compatibility APIs, not current automation.

The backend is a strict TypeScript/Express service plus an independently runnable worker. SQLite is the local source of truth and uses WAL mode. Delta India (production or Demo, per `DELTA_ENV`) is the supported exchange and order-execution environment.

## Run and verify

Requires Node.js 24 and pnpm. Install from the repository root so the shared `pnpm-lock.yaml` is used (npm installs are unsupported because they re-resolve dependencies without the lockfile). Then, from `backend/`:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm lint
pnpm build
pnpm dev
```

The API listens on port `4000` by default and stores state at `/app/data/bot.sqlite` by default. Override either with `PORT` or `DATABASE_PATH`. Docker should persist `/app/data`.

Docker images build from the repository root (`docker compose build`) with the frozen pnpm lockfile. Docker Compose loads the repository-root `.env` (copy it from the root `.env.example`; it is git-ignored) into the backend container. Set `DELTA_ENV=testnet` with `DELTA_DEMO_API_KEY` and `DELTA_DEMO_API_SECRET` for Demo, or `DELTA_ENV=production` with `DELTA_LIVE_API_KEY` and `DELTA_LIVE_API_SECRET` for Live. The selected environment's endpoint, product default, and credential pair are used together; credentials are not shared across environments. Legacy `DELTA_API_KEY` / `DELTA_API_SECRET` are used only when all environment-specific credential values are empty. Public market data and charts can run without credentials. Account telemetry and order execution require credentials for the selected Delta India environment; without them, execution stays disabled. For the Liquidity Sweep desk, `DESK_EXECUTION=delta` explicitly enables risk-gated Demo order submission at startup and requires `DELTA_ENV=testnet`; production order execution still requires `LIVE_TRADING_CONFIRMED=I_UNDERSTAND_REAL_MONEY` and the session live unlock. `NVIDIA_API_KEY` enables AI strategy advice. After editing `.env` or changing `DELTA_ENV`, run `docker compose up -d --build backend`; the desk follows `DESK_EXECUTION` on startup, while the legacy agent remains paused until explicitly enabled.

`pnpm start` starts the API and supervises the independent worker child process. The worker obtains market candles from the Delta India environment selected by `DELTA_ENV`, persists them, evaluates configured strategies on fresh closed candles, and automatically submits eligible signals only when the bot is enabled and each order has fresh risk approval. It shuts down with the API on container signals; an unexpected worker exit disables the bot and activates the local kill switch. `pnpm worker` remains available for running the worker standalone; do not run it alongside `pnpm start` against the same database.

## HTTP API

Dashboard portfolio display: `portfolio` contains `totalUsd`, `totalInr`, and nonzero `holdings` (`asset`, exact `quantity`, `valueInr`, `valueUsd`), or null with an explicit `portfolioError`. Total INR is the sum of Delta's `balance_inr` wallet valuations; USD equivalents use the display USD/INR rate. This wallet valuation is independent of trading telemetry and excludes position unrealized PnL. Missing or invalid asset valuations must not erase reconciled USD wallet telemetry, fabricate a partial total, or alter risk limits. The legacy `account.equity` field remains the USD trading wallet balance, not a multi-asset portfolio total.

- `GET /api/health`: liveness/database health used by Docker.
- `GET /api/dashboard`: market, selected-environment account availability, bot, strategy, positions, orders, recent trades, and audit snapshot. Unavailable data is reported explicitly. Account reconciliation requires credentials only, independently of live-trading confirmation. `accountEnvironment` describes credential configuration, not connection success; `accountStatus` reports reconciliation success. `executionConfigured` separately reports credentials plus any required trading confirmation and never authorizes an order.
- `GET /api/signal/preview`: evaluates the selected deterministic strategy on fresh, closed candles. This advisory preview never authorizes or submits an order.
- `GET /api/candles?tf=1m|5m|15m|30m|1h|4h|1d|1w&limit=500`: stored candles. The worker keeps candles live from the selected Delta India environment's `candlestick_<tf>` websocket channels. 1m–30m candles are chart-only; strategies use closed 1h/4h/1d/1w candles.
- `GET /api/stream?tf=1m|5m|15m|30m|1h|4h|1d|1w` (WebSocket upgrade): pushes live candles for one timeframe as `{ "type": "candle", "timeframe", "candle": { "time", "open", "high", "low", "close", "volume" } }`, after an initial `{ "type": "subscribed" }`. The worker relays persisted candles to the API process over IPC. Invalid timeframes get HTTP 400; other upgrade paths are dropped. Clients that miss heartbeats for 30 seconds are terminated.
- `GET /api/account`: private account balances and positions in the selected Delta India environment; requires Delta credentials.
- `POST /api/strategy`: accepts `{ "strategy": "meanReversion|trendBreakout|gridScalper|flat" }` or a validated frontend strategy configuration. Risk settings are persisted and clamped by backend limits; updates request an AI reevaluation.
- `POST /api/bot/toggle` with `{ "enabled": true|false }`: explicitly enables or pauses automated execution in the selected environment. Production additionally requires explicit live-trading confirmation. The bot starts paused after every process restart.
- `POST /api/kill-switch` with `{ "active": true|false }`: activating also disables the bot.
- `POST /api/ai/decision` with optional `{ "timeframe": "1h|4h|1d|1w" }`: forces reevaluation and applies only schema-validated strategy settings capped by current operator risk limits. It never directly authorizes or executes an order.

Errors use `{ "error": { "code": "...", "message": "..." } }`. Secrets and raw provider exceptions are not returned or logged.

## Safety and architecture

The system-wide leverage ceiling is 2x; lower configured/operator/AI limits remain allowed. `MAX_LEVERAGE` above 2 fails configuration validation. Startup database initialization reduces legacy persisted limits above 2 to 2 and pauses automation; it never raises lower persisted limits. Strategy updates, AI validation/application, risk approval, execution, and the order gateway independently respect the ceiling. Existing exchange positions are not modified by this migration.

The REST, order, and market-data websocket clients use the fixed Delta India endpoints for `DELTA_ENV` (`production` or `testnet`, default `testnet`). Delta Global endpoints are not selectable. Current BTCUSD product defaults are 27 (production) and 84 (Demo); `DELTA_PRODUCT_ID` may override the default, but the adapter resolves `BTCUSD` by symbol and rejects a different ID, a non-live product, or a non-operational product. For live trading set `DELTA_ENV=production`, `LIVE_TRADING_CONFIRMED=I_UNDERSTAND_REAL_MONEY`, `MAX_LEVERAGE=2`, `DAILY_LOSS_PERCENT=2`, and use a Read+Trading API key (no withdrawal) whitelisted to the laptop's static IP; keep the Windows clock NTP-synced (signatures expire after 5 s). HMAC-SHA256 authentication signs method, timestamp, request path/query, and body. Missing credentials, unavailable account data, or incomplete PnL reconciliation keeps order execution disabled.

The strategy module uses `technicalindicators`; all price, stop, take-profit, PnL, and quantity arithmetic uses `decimal.js`. `risk-core` enforces explicit bot enablement, operator leverage limits, protective-stop direction, positive sizing, and a UTC-day realized-loss breaker. Approvals include a 2:1 default risk/reward take-profit, expire after 30 seconds, and are one-use. `execution` is the only module that submits orders. Every entry requires a fresh reconciled account snapshot, a fresh `RiskApproval`, an idempotent client order ID, whole contract sizes, and exchange-side stop/target protection. Emergency closes use one-use approvals, product-scoped `reduce_only=true` orders, and authenticated exchange read-back; the account-wide close-all endpoint is intentionally not used.

NVIDIA NIM advice uses the OpenAI SDK and strict Zod validation. Set `NVIDIA_API_KEY` (or `NVIDIA_NIM_API_KEY`) in the root `.env`; `AI_MODEL` defaults to `nvidia/nemotron-3.5-bolt-e4b` and can be overridden there. The backend makes non-streaming JSON-object requests so every response can be validated before use. Only a hash of the prompt and the validated/rejected decision are stored in `ai_decision_audit`; accepted settings can only tighten persisted operator risk limits. The kill switch pauses local execution and reports exchange safety actions only when supported and confirmed.
