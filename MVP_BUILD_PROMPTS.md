# SUNNY CRYPTO MANAGER — MVP ARCHITECTURE & BUILD PROMPTS

Version 1.0 · Owner: Ahmad Shanawar Ansari · Derived from [root_planning.md](./root_planning.md) (D-001 … D-013)

Purpose: single file that holds the **final architecture** and the **ordered prompts** to give the GitHub Copilot Agent to build the MVP. The MVP is built and tested on the owner's Windows laptop in Docker, and **also deployed to a fixed-IP VPS** (Contabo, Mumbai) where the 24/7 paper soak and later live trading run (Prompt 8).

---

## 0. HOW TO USE THIS FILE

1. Create the project folder and put this file and `root_planning.md` in it (already done).
2. Paste **PROMPT 1** into the Copilot Agent. Review its output, run its acceptance checks, then continue.
3. Run prompts **strictly in order**. Never start a prompt until the previous one's *acceptance checks* pass.
4. Every prompt begins with the **Global Preamble (§3)**. After Prompt 1 the preamble lives in `.github/copilot-instructions.md`, so later prompts only need the line: `Follow the Global Preamble in .github/copilot-instructions.md.`
5. If the agent hits an *open item* (§2.6) it must **stop and ask**, not guess.
6. **Prompt 8 (VPS deployment) is part of the MVP.** Run it after Prompt 5 or Prompt 7 (your choice: after Prompt 5 starts the 4-week paper soak earlier). **Prompt 9 (live arming) is NOT part of the MVP build**; run it only after the paper gate passes.

---

## 1. WHAT WE ARE BUILDING

A risk-first automated trading system for **Delta Exchange India** perpetual futures (BTCUSD, ETHUSD, SOLUSD if available). One EMA trend-following strategy, running per symbol, passes every order through a non-bypassable risk gate, then executes in **paper** or **live** mode (paper by default). A local dashboard shows status and provides a kill switch. Telegram sends alerts.

Success = capital preservation, controlled drawdown, consistent sizing, reliability, observability. Not maximum profit.

### MVP scope
| In | Out (later) |
|---|---|
| BTC, ETH, (SOL if on Delta India) | Login/2FA, cloud hosting for UI/DB |
| 1 strategy (EMA trend + ATR stop), **configurable timeframe 5m / 15m / 30m / 1h / 4h** per symbol (default 1h) | Regime engine, extra strategies/indicators (MACD, VWAP, BBANDS, ADX, SuperTrend) |
| Market data, backfill, candles, reconnects | Funding/OI ingestion beyond backtest cost needs |
| Backtester (same strategy + risk code) | AI review layer |
| Risk engine (8 rules, kill switch) | Other exchanges, other UI pages (Markets, Signals, Strategies, Backtesting UI, AI) |
| Paper trading + **live adapter** (live only on VPS) + **VPS deployment (Contabo Mumbai)** | Redis/BullMQ, Grafana/Loki, NestJS |
| Telegram alerts | |
| Local dashboard: Dashboard, Risk Center, Trades | |

---

## 2. FINAL ARCHITECTURE

### 2.1 Topology
    Laptop (Docker Compose)                         VPS: Contabo Mumbai (same compose + prod override)
    ┌──────────────────────────────────────────┐    ┌───────────────────────────────────────┐
    │ web (Next.js)  ──reads/writes──► postgres│    │ same containers, live key, fixed IP   │
    │                                   ▲  ▲   │    │ dashboard via Tailscale / SSH tunnel  │
    │ engine (Node/TS) ─────────────────┘  │   │    └───────────────────────────────────────┘
    │   ├─► Delta India (REST+WS)          │   │
    │   └─► Telegram                       │   │
    │ migrate (one-shot)  backup (pg_dump)─┘   │
    └──────────────────────────────────────────┘
`web` never talks to the exchange. `web` and `engine` communicate **only through Postgres** (tables `engine_state`, `commands`, etc.). No inbound ports except `127.0.0.1` bindings.

### 2.2 Monorepo (pnpm workspaces + Turborepo, TypeScript strict, Node 22 LTS)
    apps/
      engine/            long-running worker; NestJS-style *module boundaries* but plain Node
        src/modules/     market-data, strategy-runner, risk-gate, execution, portfolio,
                         notifications, backtest, commands, health
      web/               Next.js (App Router) dashboard
    packages/
      core/              domain types, Money/Decimal helpers, EventBus interface, errors, config (zod), logger (pino)
      db/                Prisma schema, migrations, repositories (Repository pattern)
      exchange-sdk/      ExchangeAdapter interface + delta-india, delta-testnet, paper, mock adapters
      trading-core/      indicators (EMA, ATR, RSI), Strategy interface, EMA-trend strategy
      risk-core/         pure risk functions, position sizing, RiskApproval, kill-switch rules (highest coverage)
    docs/                documentation-first (see §2.7)
    docker/              Dockerfiles, compose files, backup script
    scripts/             deploy.sh (later), helper scripts

Rules: modules/packages expose a **public interface only**; no deep imports across modules (ESLint boundary rule). Business logic lives in packages, not in apps. No duplicated logic between backtest, paper and live.

### 2.3 Docker Compose services (all on the laptop)
| Service | Role |
|---|---|
| `postgres` | PostgreSQL 16, named volume, healthcheck, published to `127.0.0.1` only |
| `migrate` | one-shot `prisma migrate deploy`; engine/web wait for it |
| `engine` | trading engine, `restart: unless-stopped`, healthcheck, **no published ports** |
| `web` | Next.js, published `127.0.0.1:3000` only |
| `backup` | scheduled `pg_dump` to host folder `./backups` |
Profiles: default (built images) and `dev` (bind mounts + hot reload via `docker compose watch`). Env files: `.env.testnet` (default for dev) and `.env.live` (never on laptop). `.env.example` committed; real env files git-ignored. LF line endings enforced (`.gitattributes`).

### 2.4 Core design rules (non-negotiable)
1. **Exchange adapter pattern.** Nothing outside `exchange-sdk` knows Delta exists. Adapters: `delta-india` (prod URL), `delta-testnet`, `paper`, `mock`. Region guard: refuse the Delta *Global* URL (`api.delta.exchange`).
2. **Risk is a synchronous gate.** `execution` only accepts an order that carries a `RiskApproval` created by `risk-core`. No path to the exchange without it. Execution is the **only** code that places orders.
3. **Fail closed.** If kill-switch state, balance, clock sync or market-data freshness cannot be verified, **no orders** are placed.
4. **Kill switch** persisted in `engine_state`; checked before every order; set automatically on any risk-rule breach; **manual reset only** (via `commands`). On breach: block new entries, create `risk_events` row, send Telegram. Existing exchange-side stops stay in place (default; flattening is a configurable option, default OFF).
5. **Exchange is the source of truth.** On start and every N minutes, reconcile balances, positions and open orders from the exchange before trading.
6. **Idempotent orders.** Deterministic client order IDs; retries and restarts never double-submit.
7. **Exchange-side stop-loss on every entry** (bracket/stop order).
8. **Money math with decimals**, never floats. **Equity/margin/loss limits in INR** (settling asset); **prices/ATR/stops in USD**. Conversion rules confirmed from Delta docs/testnet and encoded + tested in `risk-core`.
9. **Clock safety.** Delta rejects signatures older than 5 s. Measure offset vs exchange time on start and every few minutes; apply it; block trading if drift exceeds threshold.
10. **Event-driven in-process.** Typed `EventBus` interface in `core` (in-memory implementation); modules communicate by events/interfaces, not direct calls where avoidable. Swappable later.
11. **Audit everything.** Signal → risk decision → order → fill share a **correlation ID**; persisted in `audit_logs`; JSON logs via pino.
12. **Single-instance lock** so two engines can never trade the same account.
13. **Stale-data guard** and websocket-reconnect with backoff.
14. **Paper by default.** Live requires explicit arm (config + confirm command) and is rejected unless running with the live env on the VPS.

### 2.5 Risk rules (all configurable, defaults below)
| Rule | Default |
|---|---|
| Risk per trade | 0.5% of equity (INR) |
| Max daily loss | 2% (day boundary: **Asia/Kolkata**, realized + unrealized, equity-based) |
| Max weekly loss | 5% |
| Max monthly loss | 10% |
| Max drawdown | 12% from peak equity (high-water mark); manual reset does not re-baseline unless explicitly confirmed |
| Max open positions | 3 |
| Max asset exposure | 20% of equity (notional basis, documented) |
| Max leverage | 3x |
| Correlated exposure | extra check: BTC/ETH/SOL treated as correlated; aggregate cap documented in `docs/risk/` |
| Sizing | position size = risk amount ÷ (stop distance × contract value, INR-adjusted); **reject** (never round up) if exchange minimum size would exceed risk limit |
Breach → disable trading, create risk event, Telegram alert, require manual reset.

### 2.6 Open items (agent must STOP and ask the owner; do not guess)
1. Starting capital in INR.
2. Whether SOLUSD perpetual exists on Delta India (verify via `/v2/products`; if absent, drop SOL).
3. Exact INR/USD conversion rule for PnL/margin on Delta India (confirm from docs/testnet).
4. Delta India fees, GST/TDS or other charges (not modelled until confirmed).
5. Confirm defaults in §2.5 (timezone, drawdown baseline, kill-switch behaviour).
6. Owner's Telegram bot token + chat ID (dev bot). Delta **demo** account + testnet API key.

### 2.7 Documentation (documentation-first; docs win over code)
    docs/
      MASTER_PROJECT_SPECIFICATION.md   ai-context.md        project-constitution.md
      system-overview.md                 schema.md            service-map.md      roadmap.md
      architecture/ database/ infrastructure/ services/ api/ frontend/ risk/ strategies/
      testing/ monitoring/ decisions/ (ADRs) tasks/
`MASTER_PROJECT_SPECIFICATION.md` is derived from this file + `root_planning.md`. `ai-context.md` is updated at the end of every prompt (what exists, what's next, known issues).

### 2.8 Technology
TypeScript strict · Node 22 · pnpm + Turborepo · Docker/Compose · PostgreSQL 16 + Prisma · zod · decimal.js · pino · `ws` · Vitest (80% min; ≥95% on `risk-core` and `execution`) · Playwright (UI smoke) · ESLint + Prettier + Husky · GitHub Actions (lint, typecheck, test, build) · Next.js App Router + Tailwind + ShadCN UI + React Query + Zustand + TradingView Lightweight Charts (candles) + Recharts (equity/drawdown) · Telegram Bot API.

### 2.10 Configurable timeframes (D-014)
- Supported set (enum, extendable): **5m, 15m, 30m, 1h, 4h**. Owner requirement: trade anywhere from 5-minute to 4-hour charts, chosen by configuration.
- **Config file** `config/strategies.yaml` (validated by zod at startup), one entry per *strategy instance*: `{ id, symbol, strategy, timeframe, parameters, enabled_paper, enabled_live }`. Changes apply on engine restart; a timeframe/parameter change for a symbol is **refused while that symbol has an open position** (or requires flat-first). The dashboard shows the active timeframe (read-only in MVP; editing from UI is backlog).
- **Candle storage:** 5m is the base resolution; higher timeframes are aggregated from it (UTC-aligned, complete-bar only). Backtest, paper and live read the same candles and the same aggregation code.
- **One active position per symbol** in the MVP (perpetuals net per product). Therefore one enabled strategy instance per symbol at a time; multiple timeframes for the *same* symbol simultaneously is backlog (needs netting/attribution design).
- **Timeframes on different symbols can differ** (e.g. BTC on 15m, ETH on 1h).
- Risk limits (daily/weekly/monthly loss, drawdown, max positions, exposure) are **account-wide regardless of timeframe**; the 0.5% per-trade risk is applied per trade using that timeframe's ATR stop.
- **Cost reality:** 5m/15m generate many more trades, so fees and slippage weigh far more; each timeframe must pass its own backtest/paper gate before it can be armed live. Latency (Tokyo exchange from India, laptop/VPS) is acceptable for 5m bars but not for scalping.
- **Safety scaling:** stale-data thresholds, signal-expiry (don't act on a signal older than a fraction of the bar), and rate-limit budgets scale with timeframe; a trade-frequency cap per symbol per day (configurable) protects against whipsaw on short timeframes.

### 2.9 MVP database tables
`symbols` (product_id, symbol, contract_value, tick_size, lot_size, settling_asset, enabled flags) · `candles` · `signals` · `orders` · `fills` · `positions` · `trades` · `risk_events` · `audit_logs` · `engine_state` (mode, trading_enabled, kill_switch, heartbeat, clock_offset, instance lock) · `commands` (kill switch, reset, arm live, settings; with status/ack).

---

## 3. GLOBAL PREAMBLE (paste at the top of PROMPT 1; stored in `.github/copilot-instructions.md` afterwards)

    You are building "Sunny Crypto Manager", a risk-first automated trading system for Delta Exchange India.
    Source of truth: docs/MASTER_PROJECT_SPECIFICATION.md, docs/ai-context.md, and MVP_BUILD_PROMPTS.md (architecture §2).
    If docs and code disagree, docs win. If something is unclear or is listed in §2.6 open items, STOP and ask the owner.

    Process for every task: 1) read the docs above and the docs for the module you touch; 2) update docs;
    3) write tests; 4) define interfaces; 5) implement; 6) run lint, typecheck and tests; 7) update docs and docs/ai-context.md.

    Engineering rules: strict TypeScript; SOLID, clean architecture, repository pattern, feature-based modules with public interfaces only;
    no business logic in apps (put it in packages); no duplicated logic between backtest, paper and live; decimal math for all money and quantities;
    every module has interfaces, tests, docs and a health check; 80% coverage minimum (>=95% for risk-core and execution);
    no secrets in git; Windows host with Docker Desktop (WSL2): use LF line endings and cross-platform scripts.

    Safety rules (never violate): only the execution module places orders and only with a RiskApproval from risk-core;
    fail closed; paper mode by default; exchange-side stop on every entry; idempotent client order IDs; never use the Delta Global URL;
    never log or commit API keys; live trading is forbidden on the laptop.

    Work only within the scope of the current prompt. At the end, report: what was built, how to run/verify it, test results, open questions. Do not start the next prompt.

---

## 4. PROMPTS

### PROMPT 1 — Foundation: repo, docs, Docker, CI, database  *(Stage 1)*
    [Paste the Global Preamble first.]

    GOAL: Create the monorepo foundation so that `docker compose up -d` starts postgres, migrate, engine (idle, healthy) and web (placeholder page) on the laptop, with CI green.

    TASKS
    1. Docs first: create docs/ structure from architecture §2.7. Write MASTER_PROJECT_SPECIFICATION.md (from MVP_BUILD_PROMPTS.md + root_planning.md), project-constitution.md (the principles and safety rules), system-overview.md, service-map.md, roadmap.md (stages 1-8), schema.md (tables §2.9 with columns, indexes, constraints), ai-context.md, ADRs in docs/decisions/ for D-004, D-005, D-009, D-011, D-012, D-013 (short).
    2. Create .github/copilot-instructions.md containing the Global Preamble.
    3. Monorepo: pnpm workspace + Turborepo, root tsconfig (strict), ESLint (with module-boundary rule), Prettier, Husky pre-commit (lint-staged), .gitattributes (LF), .gitignore, .editorconfig, .env.example, README.md (quick start).
    4. Packages (skeletons with interfaces + tests): core (config via zod, pino logger, Decimal/Money helpers, EventBus interface + in-memory impl, typed errors), db (Prisma schema for all tables in §2.9, first migration, repository interfaces + Prisma implementations for engine_state and commands), exchange-sdk, trading-core, risk-core (empty with interfaces only).
    5. apps/engine: bootstrap (load config, connect DB, acquire single-instance lock, write heartbeat to engine_state, expose health via a tiny internal HTTP endpoint used only by Docker healthcheck, graceful shutdown). No trading logic yet.
    6. apps/web: Next.js App Router + Tailwind + ShadCN, one placeholder Dashboard page that shows engine heartbeat from the DB (proves web<->postgres<->engine).
    7. Docker: multi-stage Dockerfiles for engine and web; docker-compose.yml (postgres, migrate, engine, web, backup) with healthchecks, depends_on conditions, 127.0.0.1-only port bindings, named volume, restart policies; docker-compose.dev.yml (watch/bind mounts); backup service that runs pg_dump on a schedule into ./backups with retention.
    8. CI: GitHub Actions workflow: install, lint, typecheck, test with coverage, build images (no push).
    9. Scripts: pnpm scripts for dev, build, test, lint, db:migrate, compose up/down/logs.

    ACCEPTANCE
    - `pnpm install && pnpm lint && pnpm typecheck && pnpm test` pass.
    - `docker compose up -d --build` -> all services healthy; `http://127.0.0.1:3000` shows live heartbeat; starting a second engine is refused by the instance lock.
    - Backup file appears in ./backups after a manual trigger.
    - Ports are bound to 127.0.0.1 only (verify with docker compose ps / netstat).
    - Docs complete; ai-context.md updated.
    STOP after reporting.

### PROMPT 2 — Exchange SDK + market data  *(Stage 2)*
    Follow the Global Preamble in .github/copilot-instructions.md.

    OPEN ITEMS FIRST: ask the owner for the Delta demo (testnet) API key and confirm env file names. Verify Delta India docs (https://docs.delta.exchange) for REST/WS endpoints, auth signing, rate limits, candle and product endpoints before coding; record findings in docs/api/delta-india.md.

    GOAL: A tested ExchangeAdapter layer and a market-data module that backfills history and streams live candles for BTCUSD, ETHUSD (and SOLUSD only if it exists on Delta India), stored in Postgres.

    TASKS
    1. Docs first: docs/api/exchange-adapter.md (interface, errors, rate limits, retry policy), docs/services/market-data.md.
    2. exchange-sdk: ExchangeAdapter interface covering: getProducts, getCandles (cursor/time pagination), subscribe candles/trades/orders, getBalances, getPositions, getOpenOrders, placeOrder (incl. bracket/stop, client order id), cancelOrder, getServerTime. Implement `delta-india` (base URL from config; refuse Global URL; User-Agent header; HMAC signing; clock-offset support), `delta-testnet`, `mock` (deterministic, for tests), cursor pagination helper, rate-limit handling with backoff, typed error mapping (including ip_not_whitelisted_for_api_key, signature expired, invalid_api_key).
    3. Symbols sync: load /v2/products into `symbols` (product_id, contract value, tick/lot size, settling asset). Verify SOLUSD availability and report it; make enabled symbols config-driven.
    4. market-data module: historical backfill (configurable depth), gap detection and repair, live candle stream via WebSocket with reconnect/backoff and heartbeat, idempotent upserts to `candles`, stale-data guard exposed as a health signal. TIMEFRAMES (architecture §2.10): store the 5m candle as the single base resolution and derive 15m, 30m, 1h and 4h by aggregation (UTC-aligned boundaries, only emit a higher-timeframe candle once all of its 5m parts are present); the supported timeframe set is a config/enum so new ones can be added without code changes elsewhere; publish a `CandleClosed` event (symbol, timeframe, candle) on the EventBus for every timeframe that any enabled strategy instance uses; stale-data threshold scales with timeframe (e.g. 2x the base 5m interval for the data feed, plus per-timeframe close-lag alert).
    5. Clock-offset service (offset vs server time, periodic, exposes `isClockSafe`), surfaced in engine_state and health.
    6. Tests: unit tests with the mock adapter, contract tests for signing against documented examples, reconnect/gap-repair tests. Optional integration test against testnet, skipped without keys.

    ACCEPTANCE
    - `docker compose up` -> engine backfills and streams candles for enabled symbols into Postgres; killing the network briefly triggers reconnect and gap repair without duplicates.
    - Candle counts match the exchange for a sampled range.
    - 48h soak instructions documented (run later by owner).
    - Coverage thresholds met; docs and ai-context updated.
    STOP after reporting.

### PROMPT 3 — Indicators, strategy, backtester  *(Stage 3)*
    Follow the Global Preamble in .github/copilot-instructions.md.

    GOAL: Verified indicators, one pluggable strategy, and a backtester that uses the SAME strategy and risk-core code as paper/live.

    TASKS
    1. Docs first: docs/strategies/ema-trend.md (rules, parameters, entry/exit/stop logic, rationale), docs/testing/backtesting.md (methodology, cost model, metrics, validation rules), docs/services/backtester.md.
    2. trading-core: indicators EMA, ATR, RSI as pure functions with decimal-safe or documented-precision math; validate against known reference values in tests (fixtures); Strategy interface (`onCandleClosed(context) -> Signal | null`, declares required indicators/warm-up, parameters schema via zod).
    3. EMA-trend strategy: long and short; fast/slow EMA cross confirmed on candle close (defaults fast 20 / slow 50, ATR 14, stop 2x ATR, optional ATR trailing stop). Works on ANY supported timeframe (5m, 15m, 30m, 1h, 4h) with per-symbol and per-timeframe parameter sets (defaults tuned separately; indicator warm-up measured in candles of the chosen timeframe). Timeframe selection comes from config (architecture §2.10), never hard-coded. No lookahead: decisions only on closed candles. Shorter timeframes (5m/15m) must model fees, slippage and funding carefully because costs dominate there; the backtest report must show cost impact explicitly (gross vs net) and trade frequency per timeframe.
    4. Backtester (engine mode + CLI `pnpm backtest --symbol --from --to --tf`): replays stored candles; simulated exchange adapter (reuses paper-adapter fill logic); applies fees, slippage, funding (configurable; fee schedule is an open item - use documented placeholders and flag clearly); PnL reported in INR using a documented USD/INR assumption; passes every order through risk-core (stub allowed only if Prompt 4 not done: implement the interface now and wire the real risk-core in Prompt 4); stores results in a `backtests` summary (add table via migration) and prints metrics: total return, CAGR, max drawdown, win rate, expectancy, profit factor, Sharpe/Sortino, trade count, exposure, per-symbol and portfolio.
    5. Validation tooling: walk-forward / out-of-sample split option, parameter-sensitivity sweep, and a clear PASS/FAIL report against thresholds defined in docs (e.g. positive expectancy after costs, max drawdown under 12%, minimum trade count, stable across the sweep). Run the full matrix of symbol x timeframe (5m, 15m, 30m, 1h, 4h) and output a comparison table (net return, max drawdown, trades/week, cost drag) so the owner can choose the timeframe per symbol on evidence.
    6. Tests: indicator reference tests, strategy scenario tests (golden candle sequences), backtester determinism test, no-lookahead test.

    ACCEPTANCE
    - Backtest runs on stored candles for each enabled symbol inside Docker (`docker compose run --rm engine pnpm backtest ...`) and writes a report to ./reports.
    - Re-running gives identical results.
    - Report states PASS/FAIL per symbol. If FAIL, the agent documents findings and proposes parameter/strategy changes but does NOT proceed to live logic.
    STOP after reporting.

### PROMPT 4 — Risk engine (risk-core + risk-gate)  *(Stage 4a)*
    Follow the Global Preamble in .github/copilot-instructions.md.

    OPEN ITEMS FIRST: confirm with owner: starting capital (INR), §2.5 defaults, INR/USD conversion rule, correlated-exposure cap. Record answers in docs/risk/.

    GOAL: A non-bypassable risk layer with the highest test quality in the repo.

    TASKS
    1. Docs first: docs/risk/risk-rules.md (every rule, formula, examples), docs/risk/money-model.md (INR equity vs USD prices, contract value, margin, conversion, fees), docs/risk/kill-switch.md (states, triggers, reset procedure), docs/services/risk-engine.md.
    2. risk-core (pure, deterministic, no I/O): position sizing; all 8 rules + correlated-exposure rule; loss windows (day/week/month in Asia/Kolkata, equity-based); drawdown from high-water mark; leverage and exposure calculators; `evaluate(intent, state, limits) -> RiskDecision`; `RiskApproval` branded type that can ONLY be created by risk-core (module-private constructor + integrity check verified by execution); rejection reasons are structured and auditable.
    3. risk-gate module (engine): builds `state` from portfolio + exchange reconciliation, calls risk-core, persists every decision to `audit_logs`, on breach: set kill switch in `engine_state`, create `risk_events`, publish event, Telegram hook (interface; implemented in Prompt 5), require manual reset command (`commands`) with confirmation; also checks clock safety, data freshness and DB readability (fail closed).
    4. Property-based and table-driven tests: boundary conditions for every limit, sizing rounding (reject, never round up), min contract size, concurrent signals, stale state, kill-switch persistence across restart.
    5. Wire the real risk-core into the backtester and re-run backtests; report any change in results.

    ACCEPTANCE
    - `risk-core` coverage >= 95% branches; mutation-style tests documented for each rule.
    - Demonstrated by test: no code path in the repo can create a RiskApproval outside risk-core, and execution rejects orders without a valid one.
    - Kill switch survives engine restart; DB unreadable => orders blocked.
    STOP after reporting.

### PROMPT 5 — Execution, paper trading, portfolio, notifications  *(Stage 4b)*
    Follow the Global Preamble in .github/copilot-instructions.md.

    OPEN ITEMS FIRST: ask the owner for the Telegram dev bot token + chat ID.

    GOAL: End-to-end loop on the laptop in PAPER mode (and Delta TESTNET): candle closed -> strategy -> signal -> risk -> execution -> fills -> portfolio -> alerts.

    TASKS
    1. Docs first: docs/services/execution-engine.md (order state machine, idempotency, reconciliation, failure modes), portfolio-engine.md, notifications.md, docs/architecture/event-flow.md (sequence diagram in mermaid).
    2. execution module: order lifecycle (new, partially filled, filled, cancelled, rejected, expired), deterministic client order IDs, bracket/stop-loss placed with every entry (exchange-side; paper adapter simulates), retry with idempotency, partial fills, order-status reconciliation against the exchange on start and periodically, cancel-all on kill switch (stops remain), verification step that a stop exists for every open position (alert + block if missing), accepts ONLY RiskApproval-carrying orders.
    3. paper adapter: simulates fills from live market data (spread/slippage/fees per config), maintains virtual balance in INR (starting capital from config), supports bracket orders, funding approximation, and behaves like the live adapter for the same interface.
    4. portfolio module: equity, realized/unrealized PnL, daily/weekly/monthly PnL, drawdown, per-asset exposure, leverage, open positions; snapshots persisted periodically (add `portfolio_snapshots` table via migration).
    5. strategy-runner module: loads strategy instances from config/strategies.yaml (zod-validated; architecture §2.10), subscribes to CandleClosed events for each instance's symbol+timeframe, runs the strategy, creates order intents with correlation IDs, handles warm-up and restarts (rebuild state from stored candles), refuses config changes for a symbol with an open position, enforces one active position per symbol, signal-expiry (ignore a signal if too old relative to the bar) and the per-symbol daily trade-frequency cap.
    6. notifications module: Telegram sender (rate-limited, retry, no secrets in logs) for: engine start/stop, heartbeat loss, clock unsafe, IP-not-whitelisted, signal/order/fill, stop missing, risk events, kill switch changes, daily summary. Separate dev/prod bots via env.
    7. commands module: processes `commands` rows from the web UI (kill switch on/off with confirm, reset, mode paper/live request, enable/disable symbol) with ack and audit; live arming is REJECTED unless env is live AND paper-gate record exists.
    8. Chaos/recovery tests: kill engine mid-order and mid-position -> restart reconciles with no duplicate orders; websocket drop; DB outage; exchange 5xx/timeouts; clock drift; duplicate signal.

    ACCEPTANCE
    - In Docker, paper mode runs the full loop on testnet/live market data; trades appear in DB; Telegram alerts arrive.
    - All chaos tests pass; coverage >= 95% on execution.
    - Attempting live mode on the laptop is refused and logged.
    STOP after reporting.

### PROMPT 6 — Local dashboard (web)  *(Stage 5)*
    Follow the Global Preamble in .github/copilot-instructions.md.

    GOAL: A minimal, reliable local UI: see everything, control the kill switch. No login (localhost only); document that auth is mandatory before any network exposure.

    TASKS
    1. Docs first: docs/frontend/ui-spec.md (pages, components, data sources, polling intervals), API contract for Next.js route handlers (docs/api/web-api.md).
    2. Data layer: Next.js route handlers reading Postgres via the db package (read-only for data; writes only to `commands`); React Query with 1-2 s polling (or SSE).
    3. Pages: **Dashboard** (engine status, mode, heartbeat, clock offset, data freshness per symbol, **active timeframe and strategy instance per symbol**, equity, PnL day/week/month, open positions, latest signals, recent orders/fills, candlestick chart with trade markers using Lightweight Charts and a timeframe selector (5m/15m/30m/1h/4h) for viewing); **Risk Center** (Equity, Drawdown, Exposure, Leverage, Daily Risk, Weekly Risk, Monthly Risk, per-limit utilisation bars, Kill Switch, Trading Status, Emergency Stop with confirm dialog, reset flow, risk events list); **Trades/Journal** (filterable table of trades with entry/exit/PnL in INR, stop/target, strategy, notes field).
    4. Clear states: loading, error, stale data (red banner if heartbeat older than threshold), paper vs live mode badge, live arm button disabled on laptop.
    5. Tests: component tests, Playwright smoke test running against compose (page loads, kill switch writes a command and engine acks it, stale banner appears when engine stopped).

    ACCEPTANCE
    - Owner can see and stop everything from http://127.0.0.1:3000; kill switch round trip UI -> DB -> engine halts within seconds.
    - Lighthouse/accessibility basics pass; no console errors; coverage met.
    STOP after reporting.

### PROMPT 7 — Hardening, observability, runbooks (laptop MVP complete)  *(Stage 5b)*
    Follow the Global Preamble in .github/copilot-instructions.md.

    GOAL: Make the MVP trustworthy for the 4-week paper soak.

    TASKS
    1. Observability: structured logs everywhere with correlation IDs, /health and /metrics (Prometheus text) per container, external heartbeat ping hook (Healthchecks.io URL from env), log rotation, docs/monitoring/.
    2. Ops docs and scripts: docs/infrastructure/runbook.md (start/stop, backup/restore drill, rotate keys, what to do on each alert, IP-change procedure, clock drift procedure, kill switch reset), scripts for backup/restore and a restore test.
    3. Security review: secrets handling, .env permissions, dependency audit, container hardening (non-root users, read-only fs where possible), localhost-only bindings verification, confirm no secret reaches logs.
    4. Full test pass: unit, integration, chaos, Playwright; CI green; coverage report committed to docs/testing/.
    5. Paper-gate tooling: a report (`pnpm paper-report`) comparing paper results vs backtest for the same period, counting risk-rule bypasses (must be zero) and listing incidents; records a `paper_gate` result per symbol in the DB used by live arming.
    6. Update ai-context.md, roadmap.md, and write docs/decisions ADRs for any deviations.

    ACCEPTANCE
    - Owner can run: `docker compose up -d`, leave the laptop plugged in, and get Telegram alerts for every defined event; restore drill documented and tested.
    - MVP build declared complete when exit gates 1-6 of root_planning.md §1B pass on the laptop and Prompt 8 (VPS) is done; gates 7-8 (testnet smoke test, first live period) belong to Prompt 9.
    STOP after reporting.

---

## 5. VPS DEPLOYMENT (MVP) AND LIVE (AFTER GATES)

### 5.0 VPS choice (D-015)
| Item | Decision |
|---|---|
| Provider | Contabo (owner already has an account) |
| Region | **India (Mumbai / Navi Mumbai)**. Contabo has an India data center, which avoids the risk that Delta India blocks or distrusts foreign datacenter IPs and gives low latency to Delta/Indian networks. Fallback: Singapore (verify Delta India accepts it first) |
| Plan | **Entry Cloud VPS tier: 4 vCPU, 8 GB RAM, 100 GB SSD (about EUR 5.50/month at time of checking; confirm price and India availability at checkout)** |
| Why this is enough | Workload = 1 Node engine + 1 Next.js app + Postgres + backup job. Expected use: ~2-3 GB RAM, light CPU (candles every 5 minutes). The next tier (6 vCPU/12 GB, ~EUR 7.50) is only needed if you add many symbols/strategies or heavy backtests on the VPS (run big backtests on the laptop instead) |
| OS | Ubuntu 24.04 LTS |
| Must-haves at order time | Dedicated public IPv4 (this is the whitelisted IP: never change it), SSH key (not password), add **snapshots** if offered, optional storage extension not needed |
| Keep in mind | Contabo shared vCPU: fine for this workload; do not run heavy parameter sweeps there. Re-check the Contabo order page for current price, region list and included IPv4 before paying. |

### PROMPT 8 — VPS deployment (paper soak on VPS)  *(MVP)*  *(owner starts this after Prompt 5 or Prompt 7; D-013, D-015)*
    Follow the Global Preamble in .github/copilot-instructions.md.
    OPEN ITEMS FIRST: confirm the VPS is the Contabo India (Mumbai) plan from §5.0 and note its fixed public IPv4. From the VPS run `curl https://api.india.delta.exchange/v2/products` and a signed testnet call to confirm Delta India accepts it; then ask the owner to whitelist that IP on the (testnet, later live) API key.
    GOAL: Same containers running 24/7 on the VPS in paper/testnet mode.
    TASKS: docker-compose.prod.yml override; scripts/deploy.sh (ssh, git pull, compose up -d --build, health verification, rollback to previous image/tag); VPS hardening guide in docs/infrastructure/vps.md (key-only SSH, ufw deny inbound except SSH, fail2ban, unattended upgrades, chrony, Docker log rotation, Tailscale or SSH-tunnel dashboard access, off-box backup copy, Contabo snapshot); external heartbeat monitor; no public ports.
    ACCEPTANCE: engine healthy on VPS for 7 days; dashboard reachable only via tunnel/Tailscale; restore drill on VPS.

### PROMPT 9 — Live arming (tiny size) on VPS  *(NOT part of MVP build; run only after paper gate passes)*
    Follow the Global Preamble in .github/copilot-instructions.md.
    PRECONDITIONS: paper gate passed for the symbol; Delta testnet smoke test passed (all order types, stops, partial fills, rejects); owner has created a Trading+Read API key on Delta India whitelisted to the VPS IP; Supabase/auth NOT required (dashboard remains private).
    GOAL: Enable live trading at minimum size with every limit active.
    TASKS: docs/risk/live-runbook.md (go-live checklist, rollback, incident handling); live arming flow (env check + paper-gate record + two-step confirm command + Telegram notice); startup reconciliation must pass before arming; per-symbol live enable; hard caps for first-period size (config); daily live reconciliation report (exchange vs DB); verification that exchange-side stops exist for every live position.
    ACCEPTANCE: owner-run checklist passes; first live order placed manually-approved at minimum size; all alerts verified.

### Backlog (later phases from the original spec)
Regime engine · extra indicators (MACD, VWAP, BBANDS, ADX, SuperTrend) and strategies · funding/OI ingestion · additional UI pages (Markets, Signals, Strategies, Backtesting, Paper, Settings) · AI review layer (OpenAI/Azure, post-trade only, never executes) · auth + cloud hosting for UI · Grafana/Loki · GitHub Actions deploy to VPS · additional exchanges.

---

## 6. MVP EXIT GATES (from root_planning.md §1B)
1. `docker compose up -d` runs everything on the laptop; CI green.
2. 48h continuous candle ingestion with reconnects handled.
3. Backtest shows robust out-of-sample edge per symbol (else iterate or drop symbol).
4. Paper gate: >= 4 weeks, zero risk-rule bypasses, results consistent with backtest.
5. Kill switch: UI -> DB -> engine halts within seconds; DB unreadable => orders blocked.
6. Restart tests: no duplicate orders; state recovered from exchange; stops verified.
7. Live smoke test on Delta testnet. 8. First live period at minimum size, no incidents.
