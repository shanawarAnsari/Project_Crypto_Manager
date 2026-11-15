# MASTER PROJECT SPECIFICATION — Sunny Crypto Manager

Version 1.0 · Owner: Ahmad Shanawar Ansari · Derived from `MVP_BUILD_PROMPTS.md` and `root_planning.md` (D-001 … D-015).
Rule: **documentation wins over code.** If docs and code disagree, the docs are right; fix the code or amend the docs through an ADR.

## 1. Purpose and success criteria

A risk-first automated trading system for **Delta Exchange India** perpetual futures (BTCUSD, ETHUSD, SOLUSD only if it exists on Delta India). One EMA trend-following strategy runs per symbol, every order passes a non-bypassable risk gate, and execution happens in **paper** or **live** mode (paper by default). A local dashboard shows status and offers a kill switch. Telegram sends alerts.

Success = capital preservation, controlled drawdown, consistent sizing, reliability, observability. Not maximum profit.

## 2. Scope

| In (MVP)                                                                                           | Out (later / backlog)                                                            |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| BTC, ETH, (SOL if on Delta India)                                                                  | Login/2FA, cloud hosting for UI/DB                                               |
| 1 strategy (EMA trend + ATR stop), configurable timeframe 5m/15m/30m/1h/4h per symbol (default 1h) | Regime engine, extra strategies/indicators (MACD, VWAP, BBANDS, ADX, SuperTrend) |
| Market data, backfill, candles, reconnects                                                         | Funding/OI ingestion beyond backtest cost needs                                  |
| Backtester (same strategy + risk code)                                                             | AI review layer (post-trade only, never executes)                                |
| Risk engine (8 rules, kill switch)                                                                 | Other exchanges; Markets/Signals/Strategies/Backtesting UI pages                 |
| Paper trading + live adapter (live only on VPS) + VPS deployment (Contabo Mumbai)                  | Redis/BullMQ, Grafana/Loki, NestJS                                               |
| Telegram alerts                                                                                    |                                                                                  |
| Local dashboard: Dashboard, Risk Center, Trades                                                    |                                                                                  |

Prompt 9 (live arming) is **not** part of the MVP build; it runs only after the paper gate passes.

## 3. Architecture

### 3.1 Topology

- **Laptop (Docker Compose):** `postgres`, `migrate` (one-shot), `engine`, `web`, `backup`.
- **VPS (Contabo, Mumbai):** the same compose plus `docker-compose.prod.yml`; live key and fixed IPv4; dashboard reached only through Tailscale or an SSH tunnel.
- `web` never talks to the exchange. `web` and `engine` communicate **only through Postgres** (`engine_state`, `commands`, …). No inbound ports except `127.0.0.1` bindings.

### 3.2 Monorepo (pnpm workspaces + Turborepo, TypeScript strict, **Node 24 LTS**)

```
apps/engine      long-running worker; modules: market-data, strategy-runner, risk-gate,
                 execution, portfolio, notifications, backtest, commands, health
apps/web         Next.js (App Router) dashboard
packages/core          domain types, Money/Decimal helpers, EventBus interface, errors, config (zod), logger (pino)
packages/db            Prisma schema, migrations, repositories
packages/exchange-sdk  ExchangeAdapter interface + delta-india, delta-testnet, paper, mock adapters
packages/trading-core  indicators (EMA, ATR, RSI), Strategy interface, EMA-trend strategy
packages/risk-core     pure risk functions, sizing, RiskApproval, kill-switch rules (highest coverage)
docs/  docker/  scripts/
```

Modules/packages expose a public interface only (ESLint boundary rule, no deep imports). Business logic lives in packages, not apps. No duplicated logic between backtest, paper and live.

### 3.3 Compose services

| Service    | Role                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| `postgres` | PostgreSQL 16, named volume, healthcheck, published to `127.0.0.1` only    |
| `migrate`  | one-shot `prisma migrate deploy`; engine/web wait for it                   |
| `engine`   | trading engine, `restart: unless-stopped`, healthcheck, no published ports |
| `web`      | Next.js, published on `127.0.0.1:3000` only                                |
| `backup`   | scheduled `pg_dump` to host folder `./backups` with retention              |

Profiles: default (built images) and `dev` (bind mounts + `docker compose watch`). Env files: `.env.testnet` (default for dev) and `.env.live` (VPS only, never on laptop). `.env.example` committed; real env files git-ignored. LF line endings enforced.

## 4. Core design rules (non-negotiable)

1. **Exchange adapter pattern.** Nothing outside `exchange-sdk` knows Delta exists. Adapters: `delta-india`, `delta-testnet`, `paper`, `mock`. Region guard refuses the Delta Global URL (`api.delta.exchange`).
2. **Risk is a synchronous gate.** `execution` accepts only orders carrying a `RiskApproval` created by `risk-core`. Execution is the only code that places orders.
3. **Fail closed.** If kill-switch state, balance, clock sync or market-data freshness cannot be verified, no orders are placed.
4. **Kill switch** persisted in `engine_state`; checked before every order; set automatically on any risk-rule breach; **manual reset only** (via `commands`). On breach: block new entries, write `risk_events`, send Telegram. Existing exchange-side stops stay (flattening is a configurable option, default OFF).
5. **Exchange is the source of truth.** Reconcile balances, positions and open orders on start and every N minutes before trading.
6. **Idempotent orders.** Deterministic client order IDs; retries and restarts never double-submit.
7. **Exchange-side stop-loss on every entry** (bracket/stop order).
8. **Decimal money math**, never floats. Equity/margin/loss limits in **INR** (settling asset); prices/ATR/stops in **USD**. Conversion rules confirmed from Delta docs/testnet and encoded + tested in `risk-core`.
9. **Clock safety.** Delta rejects signatures older than 5 s. Measure offset vs exchange time on start and every few minutes; apply it; block trading if drift exceeds threshold.
10. **Event-driven in-process.** Typed `EventBus` interface in `core` (in-memory implementation).
11. **Audit everything.** Signal → risk decision → order → fill share a correlation ID; persisted in `audit_logs`; JSON logs via pino.
12. **Single-instance lock** so two engines never trade the same account.
13. **Stale-data guard** and websocket reconnect with backoff.
14. **Paper by default.** Live requires explicit arm (config + confirm command) and is rejected unless running with the live env on the VPS.

## 5. Risk rules (all configurable)

| Rule                | Default                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risk per trade      | 0.5% of equity (INR)                                                                                                                                  |
| Max daily loss      | 2% (day boundary Asia/Kolkata, realized + unrealized, equity-based)                                                                                   |
| Max weekly loss     | 5%                                                                                                                                                    |
| Max monthly loss    | 10%                                                                                                                                                   |
| Max drawdown        | 12% from peak equity (high-water mark); manual reset does not re-baseline unless explicitly confirmed                                                 |
| Max open positions  | 3                                                                                                                                                     |
| Max asset exposure  | 20% of equity (notional basis, documented)                                                                                                            |
| Max leverage        | 3x                                                                                                                                                    |
| Correlated exposure | BTC/ETH/SOL treated as correlated; aggregate cap documented in `docs/risk/`                                                                           |
| Sizing              | size = risk amount ÷ (stop distance × contract value, INR-adjusted); **reject, never round up**, if exchange minimum size would exceed the risk limit |

Breach → disable trading, create risk event, Telegram alert, require manual reset. Limits are account-wide regardless of timeframe.

## 6. Technology

TypeScript strict · **Node 24 LTS** · pnpm + Turborepo · Docker/Compose · PostgreSQL 16 + Prisma · zod · decimal.js · pino · `ws` · Vitest (80% min; ≥95% on `risk-core` and `execution`) · Playwright (UI smoke) · ESLint + Prettier + Husky · GitHub Actions (lint, typecheck, test, build) · Next.js App Router + Tailwind + ShadCN UI + React Query + Zustand + TradingView Lightweight Charts + Recharts · Telegram Bot API. Thin in-house Delta client (REST + `ws`) behind the adapter interface.

## 7. Timeframes (D-014)

- Supported set (enum, extendable): **5m, 15m, 30m, 1h, 4h**; chosen per symbol in `config/strategies.yaml` (zod-validated at startup): `{ id, symbol, strategy, timeframe, parameters, enabled_paper, enabled_live }`.
- Changes apply on engine restart; a timeframe/parameter change is refused while that symbol has an open position.
- **5m is the base candle resolution**; higher timeframes are aggregated from it (UTC-aligned, complete bars only), with the same code for backtest, paper and live.
- One active position per symbol; one enabled strategy instance per symbol. Different symbols may use different timeframes.
- Fees and slippage weigh heavily on 5m/15m; each symbol×timeframe must pass its own backtest/paper gate before live arming.
- Stale-data thresholds, signal expiry and rate-limit budgets scale with timeframe; a per-symbol daily trade-frequency cap guards against whipsaw.

## 8. Delta Exchange India facts (re-verify when building; invent nothing beyond these)

- Production API `https://api.india.delta.exchange` (the `api.delta.exchange` URL is Delta Global and must NOT be used). Testnet/demo API `https://cdn-ind.testnet.deltaex.org` with keys from `demo.delta.exchange`; keys are not interchangeable.
- BTCUSD/ETHUSD perpetuals are quoted in USD but margined and settled in INR; confirm settling asset per product via `/v2/products`.
- Orders use product IDs, not symbols. SOL availability on Delta India is **not confirmed**.
- API key permissions: Read Data and Trading (no withdrawal permission to grant).
- IP whitelisting is enforced (`ip_not_whitelisted_for_api_key`); signatures must be < 5 s old; a `User-Agent` header is required; cursor-based pagination on products/orders/fills; data centers are in AWS Tokyo.

## 9. Money model (summary; detail in `docs/risk/money-model.md`)

Equity, margin, loss limits and drawdown in INR; prices, indicators and stop distances in USD. Size = (risk % × INR equity) ÷ (USD stop distance × contract value × USD/INR rule applied by the exchange). Backtests report INR PnL under a documented USD/INR assumption. Fees, funding, GST/TDS are not modelled until confirmed (open item).

## 10. Database tables

`symbols`, `candles`, `signals`, `orders`, `fills`, `positions`, `trades`, `risk_events`, `audit_logs`, `engine_state`, `commands`. Added later: `backtests` (Prompt 3), `portfolio_snapshots` (Prompt 5). Detail in [schema.md](./schema.md).

## 11. Deployment (D-013, D-015)

Live trading runs **only on a VPS** (fixed IP required for Delta whitelist). Laptop = dev, backtest, testnet, paper. VPS: Contabo India (Mumbai), entry Cloud VPS (4 vCPU / 8 GB / 100 GB, confirm price at checkout), Ubuntu 24.04, dedicated IPv4, key-only SSH, `ufw` deny inbound except SSH, fail2ban, unattended upgrades, chrony, Docker log rotation, Tailscale/SSH-tunnel dashboard, off-box backups, Contabo snapshots, external heartbeat monitor. Deploy via `scripts/deploy.sh`. First check on the VPS: Delta India accepts its IP (`curl https://api.india.delta.exchange/v2/products` and a signed testnet call).

## 12. Open items (agent must STOP and ask the owner; never guess)

1. Starting capital in INR.
2. Whether a SOLUSD perpetual exists on Delta India (verify via `/v2/products`; drop SOL if absent).
3. Exact INR/USD conversion rule for PnL/margin on Delta India.
4. Delta India fees, GST/TDS or other charges.
5. Confirm §5 defaults (timezone, drawdown baseline, kill-switch behaviour).
6. Telegram dev bot token + chat ID; Delta demo account + testnet API key.
7. Correlated-exposure aggregate cap.

## 13. MVP exit gates

1. `docker compose up -d` runs everything on the laptop; CI green.
2. 48h continuous candle ingestion with reconnects handled.
3. Backtest shows a robust out-of-sample edge per symbol (else iterate or drop the symbol).
4. Paper gate: ≥ 4 weeks, zero risk-rule bypasses, results consistent with backtest.
5. Kill switch: UI → DB → engine halts within seconds; DB unreadable ⇒ orders blocked.
6. Restart tests: no duplicate orders; state recovered from the exchange; stops verified.
7. Live smoke test on Delta testnet. (Prompt 9)
8. First live period at minimum size, no incidents. (Prompt 9)

MVP build is complete when gates 1–6 pass on the laptop and Prompt 8 (VPS) is done.

## 14. Documentation set

`MASTER_PROJECT_SPECIFICATION.md`, `ai-context.md` (updated at the end of every prompt), `project-constitution.md`, `system-overview.md`, `service-map.md`, `roadmap.md`, `schema.md`, and folders `architecture/ database/ infrastructure/ services/ api/ frontend/ risk/ strategies/ testing/ monitoring/ decisions/ tasks/`.
