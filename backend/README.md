# Sunny Crypto Manager backend

## Delta India demo desk (default)

`pnpm dev` / `pnpm start` run the demo-only candidate desk (`src/desk-server.ts`; see
[src/desk/README.md](src/desk/README.md)). It binds to localhost by default and stores its isolated,
provenance-checked journal in `DESK_DATABASE_PATH`.

| Variable | Default | Meaning |
|---|---|---|
| `DELTA_ENV` | `testnet` | The desk rejects production/live endpoints |
| `DELTA_DEMO_API_KEY` / `DELTA_DEMO_API_SECRET` | empty | Optional for public market observation; both required for Demo account data and orders |
| `DELTA_IP_FAMILY` | `4` | Pin exchange API requests to IPv4 for API-key IP allowlists |
| `DESK_INSTRUMENTS` | `BTCUSD,ETHUSD` | Allowed Delta India Demo symbols |
| `DESK_EXECUTION` | `disabled` | Set to `delta` to permit arming from Settings; each process starts disarmed |
| `DESK_MAX_LEVERAGE` | `2` | Hard maximum is 2x |
| `DESK_STARTING_BALANCE` | `10000` | Historical Lab starting equity only; never shown as a wallet or used as an account fallback |

Synthetic feeds, planted scenarios and the paper ledger have been removed from the default desk.
The account panel displays only current exchange values; no credentials means account/order controls stay disabled.
Live candles are display-only until closed, and strategy decisions use consecutive, fresh closed bars.
An explicitly armed Demo scanner verifies the account before each entry, allows one open position, and waits
for exchange positions and working orders to clear before another. Restarts, pause, or risk/data faults disarm it.

The separate `pnpm dev:legacy` entry point is retained for compatibility, is also restricted to Delta testnet,
and is not the frontend's default app or a paper/synthetic feed.

### Historical strategy Lab

`GET /api/strategies` returns `{ strategies: [{ id, name, family, lookback }, …] }`. To replay one candidate, `POST /api/backtest` with a configured `instrument`, `strategyId`, `resolution` (`5m`, `15m`, `1h`, `4h`, `1d`), `start` and `end`. Times are aligned UTC Unix **seconds**, start inclusive and end exclusive. Only closed candles within the last five calendar years are accepted. Optional assumptions are `feeBps` (minimum/default 5.9 per side, including GST), `slippageBps` (2 per side), and `spreadBps` (1 across the bid/ask). Raise the estimates to reflect higher actual costs.

The Lab reads **public Delta India market history**, not a Demo account ledger. `GET /api/lab/coverage?instrument=BTCUSD&resolution=5m` returns `launchTime` and `earliestStart` in Unix seconds. The latter is the later of the five-year floor and the first aligned interval opening at or after the public product's `launch_time`. This is a listing boundary, not a guarantee of continuous history. A backtest inside the five-year limit trims a pre-listing start and returns both `requestedStart` and effective `start`, plus `coverage`. A wholly pre-listing or insufficient post-listing range fails before any candle query. If the exchange listing time is unavailable, the Lab does not guess. Every page (up to 2,000 candles) must be complete from the effective start; duplicates, gaps and malformed OHLCV invalidate the run. A successful response includes `strategyId`, `strategyName`, costs, candle count, gross and net statistics, sampled mark-to-market equity, monthly realized results and the last 100 trades. Errors return `{ ok: false, message }` and a non-2xx status; concurrent runs return 409.

Signals use only prior closed bars. The simulator enters at the next open, models both legs' costs, checks a 1% stop before a 2% target on ambiguous bars, accounts for gaps through stops and closes at range end. Sizing uses fractional units capped at 1× simulated equity; funding, contract rounding, latency and Demo account risk checks are not simulated. Backtesting does not activate a strategy or place any order.

## Legacy chat API (separate compatibility surface)

The following legacy API details do not describe the default desk's strategy, risk, account, or execution path.
They remain in the repository for compatibility and are restricted to the configured Delta Demo environment.
The UI entry point does not load the legacy dashboard.

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
