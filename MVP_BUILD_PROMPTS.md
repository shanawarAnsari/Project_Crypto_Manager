# MVP Build Scope

## 1. Product

Build a Docker Compose BTC trading terminal with a Node.js/Express/TypeScript backend and React/Vite/TypeScript frontend. Connect to the owner's Delta Exchange India account (`DELTA_ENV=production`, `https://api.india.delta.exchange`); the Demo/testnet environment remains selectable for development (`DELTA_ENV=testnet`, the default). After the operator explicitly enables the bot, eligible strategy signals are submitted autonomously from the laptop after per-order risk approval. Owner decision 2026-11-17: real-money production trading from the laptop is permitted, for BTCUSD only in this MVP.

## 2. Architecture

### 2.1 Workspace layout

- `backend/`: HTTP API, worker, SQLite persistence, market data, AI router, risk engine, strategies, and the sole execution boundary.
- `frontend/`: responsive dark trading terminal consuming the backend API.
- Root: pnpm workspace, Turborepo tasks, Compose services, environment example, and `data/` persistence mount.

### 2.2 Backend

Use strict TypeScript, Express, `better-sqlite3` in WAL mode, Zod, `technicalindicators`, OpenAI SDK against NVIDIA NIM, and Vitest. Persist bot state, candles (1h/4h/1d/1w), trade logs, and AI decision audits. Provide typed Delta India REST signing and market/account data integration, plus a reconnecting market-data websocket. Keep worker lifecycle separate from HTTP handlers.

### 2.3 Risk and execution

Owner leverage update: 2x is the hard maximum across configuration, API, AI, risk, execution, and gateway, superseding the earlier 3x ceiling below. Lower limits remain valid. Legacy persisted limits above 2x are reduced during database initialization with automation paused; existing exchange positions are not changed.

Implement `meanReversion`, `trendBreakout`, `gridScalper`, and `flat` signals. Risk rules—not AI—clamp leverage and enforce a UTC daily-loss breaker. An order requires a valid `RiskApproval`; only the execution module may submit it.

AI may configure strategy parameters only within operator risk caps; deterministic strategies generate the actual trade signals. A UI preview is advisory and cannot place an order. The UI labels the selected environment **LIVE** (production) or **TESTNET** (testnet), independently of account verification. After explicit operator enablement, eligible signals are submitted automatically without per-trade confirmation. Before each order, reconcile account-wide realized PnL from the current UTC day's USD wallet transactions (using the documented epoch-microsecond bounds and cursor pagination) and unrealized PnL from all current positions. Use the wallet's native unit for both PnL and its loss cap. The daily loss cap is `DAILY_LOSS_PERCENT` (default 2%) of start-of-day capital (equity minus today's PnL), never above `MAX_DAILY_LOSS`; maximum leverage defaults to 2x (hard ceiling 3x). Missing, malformed, incomplete, or unsupported data keeps trading locked; missing credentials disable order execution without fallback. The bot must start paused after restart and require explicit re-enablement. Every order must be submitted through the execution boundary with a fresh `RiskApproval`, an idempotent client order ID, and exchange-side stop protection. Order sizes are converted from approved base units to whole contracts using the product `contract_value`; bracket prices are snapped to `tick_size` toward entry; only the live BTCUSD product is accepted. Production execution additionally requires `LIVE_TRADING_CONFIRMED=I_UNDERSTAND_REAL_MONEY`; the Delta Global URL is never used.

### 2.4 AI router

Owner amendment 2026-11-17: replace the deck with a persistent Demo-only chat trading agent and
live activity summaries. The agent directly proposes wait/open/hold/owned-close actions, with
independent risk/execution enforcement. Combined timeframe/cadence selector defaults to 5m
(1m/5m/15m/30m/1h). Disable legacy worker entries. Owner policy: <=25% USD equity as margin,
<=2x leverage, stop loss plus tax-inclusive round-trip fees <=5% of allocation, <=5 UTC entries,
10% Demo daily loss cap still bounded by MAX_DAILY_LOSS. No production agent orders.
See the master specification's Demo chat agent contract for lifecycle and reconciliation rules.

Send compact multi-timeframe market context and operator instruction to NVIDIA NIM with low temperature. Validate a strict strategy/parameter/reasoning schema with Zod. Persist raw-safe request context and parsed decisions; never store credentials or authorization headers. Invalid or unavailable AI output must not enable execution.

### 2.5 Frontend

Owner presentation update: retain Wallet portfolio (indicative) and USD trading wallet cards; omit the Wallet Holdings panel and successful live-account verification sentence. Keep account/portfolio errors visible. Show the configured leverage cap (at most 2x), not a fabricated position leverage.

Display live market and connection state, an environment badge (LIVE/TESTNET), bot control and kill switch, account/risk telemetry, multi-timeframe candles with overlays and execution markers, strategy parameters/instruction editor, AI reevaluation, deterministic strategy-signal preview, and position/order/audit/history tabs. Separate verified account connectivity from environment selection and trading readiness (`executionConfigured`). Read-only account reconciliation must not require trading confirmation. Never show unverified account values or claim connectivity from credentials alone. Clearly show when automated trading is enabled, paused, or blocked. Disable Start without verified telemetry and trading configuration or while a risk lock is active; retain Stop for an enabled bot. Show explicit errors and do not imply a failed backend action succeeded.

The strategy selector must be a dropdown containing every supported deterministic strategy: mean reversion, trend breakout, grid scalping, and flat (no entries). A selection remains a draft until the operator applies the strategy.

### 2.6 Exchange configuration and operational prerequisites

Balance display: show total wallet portfolio value and individual nonzero asset quantities separately from the USD trading wallet balance and available margin. Sum Delta's own `balance_inr` wallet valuations; derive indicative USD equivalents using the adapter's display USD/INR rate. Do not substitute derivative ticker prices. Missing or invalid wallet valuations must surface as unavailable, not a partial portfolio total. Exclude position unrealized PnL from wallet totals; do not use non-USD valuations as trading collateral or to increase risk limits.

Endpoints are fixed in the adapter by an allow-list keyed on `DELTA_ENV` (`production`: `https://api.india.delta.exchange` and `wss://socket.india.delta.exchange`; `testnet`: `https://cdn-ind.testnet.deltaex.org` and `wss://socket-ind.testnet.deltaex.org`); default `testnet`. The current BTCUSD product defaults are `27` for production and `84` for Demo. Resolve the product by its documented `BTCUSD` symbol route and verify the returned product ID, live state, and operational status before order placement. The exchange adapter must fail closed when endpoint semantics or required safety fields cannot be verified. Credentials are required for telemetry and order execution; their absence must not prevent the dashboard from starting, but must keep order execution disabled. Production keys must be Read+Trading only (no withdrawal) and IP-whitelisted to the laptop's static IP; keep the system clock NTP-synced (signatures expire after 5 s). Automated trading requires explicit bot enablement, starts paused after restart, and must obtain fresh risk approval for every order. Emergency closes must be product-scoped reduce-only orders and verified with read-back; the documented account-wide close-all endpoint is not used.

Use separate environment variables for exchange credentials: `DELTA_DEMO_API_KEY` / `DELTA_DEMO_API_SECRET` with `DELTA_ENV=testnet`, and `DELTA_LIVE_API_KEY` / `DELTA_LIVE_API_SECRET` with `DELTA_ENV=production`. Never send Demo keys to Live endpoints or Live keys to Demo endpoints. Legacy `DELTA_API_KEY` / `DELTA_API_SECRET` may be used only when no environment-specific credential values are configured. Switching `DELTA_ENV` requires recreating the backend; the bot must remain paused after restart.

## 3. API

Implement `GET /api/health`, `GET /api/dashboard`, `GET /api/candles?tf=1h|4h|1d|1w`, `POST /api/strategy`, `POST /api/bot/toggle`, and `POST /api/kill-switch`. Validate all request bodies and return explicit status/error details.

## 4. Operations and validation

Compose runs backend on port 4000 and frontend on port 3000, proxies frontend API requests to the backend, persists SQLite at `./data/bot.sqlite`, and health-checks the backend. Provide workspace build, lint, typecheck, and test scripts. Test risk gating, automatic Demo execution after explicit enablement, fresh approval for every order, paused startup after restart, environment-specific product selection, Delta India endpoint allow-listing, emergency-action read-back, database behavior, API validation, and frontend controls.
