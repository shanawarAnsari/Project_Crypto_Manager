# ROOT PLANNING — Sunny Crypto Manager

> Living record of every discussion, decision and open question for this project.
> When planning is complete, this file (plus the master spec below) becomes the source for the phase-wise prompts given to the GitHub Copilot Agent.

- **Owner:** Ahmad Shanawar Ansari
- **Created:** 2026-11-15
- **Status:** PLANNING (no code yet)
- **Rule:** Documentation wins over code. Every decision is logged here first, then promoted into `docs/`.

---

## 1. How to use this file

1. Discuss → record the outcome in **§5 Decision Log** (never silently change the spec).
2. Unresolved items live in **§6 Open Questions** until answered.
3. When a decision changes the spec, update **§3 Master Spec** and add a line to **§9 Changelog**.
4. When planning is done, generate the phase prompts in **§8** and hand them to the agent one phase at a time.
5. Final home of these contents: `docs/MASTER_PROJECT_SPECIFICATION.md`, `docs/decisions/` (ADRs), `docs/ai-context.md`.

---

## 1A. FINAL BLUEPRINT (D-009) — read this first

> Consolidates and replaces the competing proposals in §7B, §7C, §7D. If anything below conflicts with an older section, **this section wins**.
>
> **D-011 amendment:** for the MVP everything runs **locally** (laptop + Docker + local Postgres), **no login**. Wherever §1A mentions Vercel, Supabase, VPS or 2FA, read it as **"later, at cloud migration"**. Live orders and ETH/SOL are in the MVP (see §1B). The architecture, safety design and stage gates below are otherwise unchanged.

### The approach in one paragraph
Build a **small, boring, safe system first and let it earn complexity**. The hard part of this project is not infrastructure; it is (a) a strategy with a real edge and (b) a risk layer that never fails. So: one repo, **two deployables**, one database, paper-trade for weeks, go live with tiny size, and only then add features/vendors.

### Architecture (final)
```
 Browser ──> web  (Next.js on Vercel) ──> Supabase (Postgres + Auth + Realtime)
                                              ▲        │  settings / commands (kill switch)
                                              │        ▼
                         engine (Node + TypeScript, Docker) ──> Delta Exchange (REST + WS)
                                              └────────────────> Telegram alerts
```
| Piece | Choice | Why |
|---|---|---|
| Language / monorepo | TypeScript, pnpm + Turborepo | One language end to end, shared types |
| `apps/web` | Next.js, Tailwind, ShadCN, React Query, TradingView Lightweight Charts (+ Recharts for stats) | UI only; never talks to the exchange |
| `apps/engine` | Plain Node/TypeScript worker with clean module boundaries (market-data, indicators, strategy, risk, execution, portfolio, paper/backtest modes) | Always-on process: websocket, risk loop, reconciliation. Not NestJS or microservices until a real need appears |
| `packages/` | `core` (domain, types, events), `exchange-sdk` (adapter interface + Delta + mock), `trading-core` (indicators, strategies, regime), `risk-core` (isolated, highest test bar) | Same strategy and risk code used by backtest, paper and live |
| Database | **Supabase** (Postgres, Auth with 2FA, Realtime, RLS) | One managed service for DB + login + live UI updates. Free to start; upgrade to Pro before real capital (backups) |
| Docker | Docker Compose for local (engine + local Postgres); engine image in prod | Confirmed (D-005) |
| Web hosting | Vercel | Zero-ops for Next.js |
| Engine hosting | Laptop (dev + paper), Contabo VPS (live, fixed IP for Delta whitelist, outbound-only, no open ports) | Engine needs a persistent process and static IP; Vercel can't provide either |
| CI/CD | GitHub + Actions (lint, typecheck, test, build image → GHCR); Vercel auto-deploys web | |
| Alerts / monitoring | Telegram, Healthchecks.io heartbeat, Sentry (free), structured logs | Grafana/Loki later |
| AI | Phase 11 only, post-trade review, behind a provider interface | |

**Deliberately NOT in v1** (from the original spec): Redis, BullMQ, NestJS, Nginx Proxy Manager, Cloudflare Pages, Neon, Upstash, Grafana/Loki, 13 separate services. Each can be added later if a measured need appears; module boundaries make that cheap.

### Non-negotiable safety design
1. Risk is a **synchronous gate**: Execution only accepts orders carrying a risk approval from `risk-core`.
2. Kill switch persisted in DB; unreadable = **block trading** (fail closed).
3. Exchange is source of truth: reconcile positions/orders/balance on start and periodically.
4. Idempotent orders (deterministic client order IDs); exchange-side stop-loss on every entry.
5. Single engine instance lock; stale-data guard; heartbeat/dead-man alert.
6. Decimal math (no floats); full audit trail with correlation IDs.
7. `TRADING_MODE=paper` by default; live keys exist only on the VPS (trade-only, no withdrawal, IP-whitelisted).
8. Exchange adapter pattern: nothing outside `exchange-sdk` knows about Delta.

### Build path (replaces the 11-phase order in §3.11; each stage has an exit gate)
| Stage | Goal | Maps to old phase | Exit gate |
|---|---|---|---|
| 0. Decide | Answer the must-decide questions below; freeze v1 scope (BTC, 1 strategy, 1 timeframe) | — | Decisions logged |
| 1. Foundation | Repo, short docs set, ai-context, Docker Compose, CI, Supabase project, schema v1 (~10 tables) | 1, 2 | `docker compose up` works; CI green |
| 2. Market data | Delta adapter (REST history + WS), candle storage, reconnect, mock adapter | 3 | Candles stream and backfill reliably for 48h |
| 3. Research | Indicators, 1 strategy, backtester with fees + slippage + funding | 4, 5, 6 | Strategy shows a positive, robust edge out-of-sample; **if not, iterate strategy before building more** |
| 4. Risk + Paper | `risk-core`, execution gate, paper trading on live data, Telegram alerts, kill switch | 7, 8 | ≥4 weeks paper, zero risk-rule bypasses, results match backtest |
| 5. Dashboard | Minimal UI: Dashboard, Risk Center, Trades/Journal, Live status | 9 | Owner can see and stop everything from the UI |
| 6. Live (tiny) | VPS engine, live key, minimum position size, all limits active | 10 | N weeks live with no incidents |
| 7. Expand | ETH/SOL, more strategies, regime engine, AI review, extra pages, other exchanges | 11 + future | Per-feature gate |

### Must-decide before Stage 1 (answer these; everything else follows)
1. Instrument: Delta **perpetual futures** (assumed) vs spot/options.
2. Starting capital and currency (USDT/INR).
3. v1 strategy style and timeframe (e.g. EMA trend-following on 1h/4h) — slow timeframes are far safer for a first system.
4. Dev machine OS/Docker ready on laptop (Windows + Docker Desktop).
5. Supabase free now, Pro before live: agreed?
6. Kill-switch behaviour: block new entries only, or flatten positions?

### Estimated running cost (v1)
Local dev: free. Vercel Hobby + Supabase free: free (Hobby is non-commercial). VPS only when going live (you already have Contabo). Before real capital: Supabase Pro (~$25/mo).

---

## 1B. MVP DEFINITION (D-010, amended by D-011)

> **Amendment D-011 (owner request, 2026-11-15):** the MVP runs **locally only** (laptop, Docker); **no login/2FA**; **live orders are IN the MVP**; **ETH and SOL are IN the MVP** (BTC + ETH + SOL). Rows below are already updated; Supabase/Vercel/VPS are **deferred** to the cloud-migration step (§7A).

**MVP = Stages 1–6 of §1A, running locally:** a system that ingests live BTC, ETH and SOL data from Delta, runs one strategy through the full risk gate, executes in **paper or live mode** (paper by default; live must be explicitly armed), alerts via Telegram, and shows everything on a local dashboard with a working kill switch.

### Live-from-laptop guardrails (required because D-004 originally forbade this)
1. Live is **armed explicitly** (config flag + confirmation command); engine always boots in paper mode.
2. **Exchange-side stop-loss on every entry** (bracket/stop order) so a sleeping laptop or lost network cannot leave a position unprotected.
3. Laptop must not sleep (power plan) and the engine uses Docker `restart: unless-stopped`; on startup it **reconciles with the exchange** before trading.
4. Web UI and any engine port bind to **127.0.0.1 only** (no login is acceptable only because nothing is reachable from the network).
5. Live API key: **trade-only, no withdrawal**, IP-whitelisted if Delta requires it (home IP may change: verify Delta's rule; update whitelist or move engine to a fixed-IP VPS later). Key lives in git-ignored `.env`, never committed.
6. Start live at **minimum position size**; all 8 risk limits active from day one.
7. Telegram alert on engine start/stop, heartbeat loss, every live fill and every risk event.
8. Live arming is blocked until the paper-trading gate (below) has passed for that symbol.

### Services in the MVP (modules inside `engine`, plus `web`)
| # | Service / module | Lives in | MVP scope | Why it's in the MVP |
|---|---|---|---|---|
| 1 | Exchange adapter (`exchange-sdk`) | package | Delta REST (history, ticker, orders, positions, balances) + WebSocket (candles/trades/order updates), `mock` adapter, `paper` adapter, `delta-live` adapter; per-symbol contract specs (tick size, lot size, contract value) for BTC/ETH/SOL perpetuals | Single door to the exchange; same interface for paper and live |
| 2 | Market data | engine | Backfill history, live candle stream, reconnect, stale-data guard, store candles for BTC, ETH, SOL | No data, no system |
| 3 | Indicators + strategy (`trading-core`) | package | EMA, ATR (+ RSI optional); **one** strategy: EMA trend-following with ATR stop, 1h or 4h, run independently per symbol; common `Strategy` interface | Proves the plugin interface without building 5 strategies |
| 4 | Backtester | engine mode / CLI | Replays stored candles through the same strategy + risk code; includes fees, slippage, funding; per-symbol and portfolio metrics | Tells us whether the strategy deserves to go live |
| 5 | Risk (`risk-core`) | package | All 8 rules (0.5% risk/trade, 2/5/10% loss limits, 12% drawdown, 3 positions, 20% asset exposure, 3x leverage); position sizing respecting exchange minimum contract size; kill switch; risk events | The most important component; must exist before any execution |
| 6 | Execution | engine | Order lifecycle, idempotent client IDs, bracket/stop orders, partial fills, order-state reconciliation; accepts only risk-approved orders; **paper and live adapters** | Enforces "risk cannot be bypassed"; the only code that places orders |
| 7 | Portfolio | engine | Equity, PnL, drawdown, per-asset exposure, positions across BTC/ETH/SOL | Needed by risk rules and the dashboard |
| 8 | Notifications | engine | Telegram: fills, risk events, kill switch, engine down/up, heartbeat loss | Operational safety, essential for live |
| 9 | Web UI | `apps/web` | **No login** (localhost only). **Dashboard**, **Risk Center** (equity, drawdown, exposure, leverage, daily/weekly risk, trading status, kill switch, emergency stop, paper/live mode + arm button), **Trades/Journal** list | Minimum visibility and control |

### ETH + SOL notes
- BTC, ETH and SOL are highly correlated: three simultaneous positions behave like one concentrated bet. Risk engine should track **correlated exposure** in addition to the per-asset 20% cap; max 3 open positions (≈ one per asset) stays as specified.
- Each symbol has its own config: contract specs, minimum order size, strategy parameters, enabled flags (paper/live separately).
- With small capital, 0.5% risk per trade may be below the exchange's minimum contract size for some symbols; the sizer must **reject (not round up)** trades that would exceed the risk limit.

### Explicitly NOT in the MVP
Login/2FA/auth, cloud hosting (Vercel, Supabase, VPS), regime engine, AI review, extra indicators (MACD, VWAP, BBANDS, ADX, SuperTrend), extra strategies, Markets/Signals/Strategies/Backtesting UI pages, other exchanges, Redis/BullMQ, Grafana/Loki, funding/open-interest ingestion beyond what backtest cost modelling needs.

### Tech stack for the MVP, and why
| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict), Node 22 LTS | One language for UI, engine and shared libs; your spec requires it; shared types prevent contract drift |
| Monorepo | pnpm workspaces + Turborepo | Fast installs, cached builds, simple package sharing |
| Engine runtime | Plain Node worker in Docker | Needs a long-running process; NestJS adds ceremony the MVP doesn't need. Clean module boundaries preserve the "services" design |
| Exchange client | Thin in-house Delta client (REST + `ws`) behind the adapter interface | Keeps Delta isolated and testable; avoids a heavy or unmaintained third-party SDK |
| Indicators | `indicator-core` inside `trading-core`, validated against known reference values (library such as `trading-signals` may back it) | Trading maths must be verified, not trusted |
| Money / numbers | `decimal.js` (or similar) | Floats cause rounding bugs in sizing and PnL |
| Validation / config | `zod` | Typed env config and event/API contracts |
| Database | **Postgres container** (Docker Compose, persistent volume) | Local-only; no cloud account needed. Plain Postgres means the same schema moves to Supabase/Neon later by changing `DATABASE_URL` |
| ORM / migrations | Prisma (per spec) | Typed queries, versioned migrations, repository pattern fits |
| UI | Next.js (App Router), Tailwind, ShadCN UI, React Query, Zustand, TradingView Lightweight Charts, Recharts | Per spec; Lightweight Charts for candles, Recharts for equity/drawdown |
| Live UI updates | React Query polling (1–2 s) or SSE from Next.js route handlers reading Postgres | Simple; no websocket server or Realtime service needed locally |
| Auth | **None in MVP**; UI and DB ports bound to 127.0.0.1 | Owner decision; safe only while nothing is network-reachable. Auth becomes mandatory before any cloud exposure |
| Engine ↔ UI | Postgres tables (`engine_state`, `commands`, `risk_events`, `positions`…) | Decoupled; kill switch is a DB row also checked before every order (unreadable = block) |
| Events | Typed in-process `EventBus` interface in `core` | Event-driven design without a broker; swappable later |
| Logging | `pino` JSON logs with correlation IDs | Audit + later Loki without code change |
| Testing | Vitest (all packages), Playwright (UI smoke), 80% min; ≥95% target on `risk-core`, `execution` | Matches spec; money-touching code gets the strictest bar |
| Local env | Docker Compose: `engine`, `postgres`, `migrate`, `web`, `backup` (see §1C); secrets in git-ignored `.env.*` | Confirmed Docker (D-005); whole system runs in containers on the laptop |
| CI/CD | GitHub Actions: lint → typecheck → test → build images | Standard, free tier sufficient; deploy steps added at cloud migration |
| Alerts | Telegram Bot API | Per spec; instant mobile alerts, vital with live orders |
| Hosting (MVP) | Laptop only | Free; cloud move later per §7A |
| Backups | Nightly `pg_dump` of the Postgres volume to a second location | Live trade history must not live on a single disk |

### MVP database tables
`symbols`, `candles`, `signals`, `orders`, `fills`, `positions`, `trades`, `risk_events`, `audit_logs`, plus `engine_state` and `commands` (kill switch, mode, settings). No user tables (no auth).

### MVP exit gates
1. `docker compose up` runs the engine locally; CI is green.
2. 48h continuous candle ingestion for BTC/ETH/SOL with reconnects handled.
3. Backtest shows a robust edge on out-of-sample data per symbol (else iterate strategy or drop the symbol).
4. **Paper gate (required before live arming):** ≥4 weeks paper trading, zero risk-rule bypasses, paper results consistent with backtest.
5. Kill switch tested: UI → DB → engine halts within seconds; DB unreadable → engine blocks orders.
6. Restart tests: engine killed mid-position recovers state from the exchange with no duplicate orders; exchange-side stops verified present.
7. Live smoke test on **Delta testnet** (all order types, stops, partial fills, rejects) before using a real key.
8. First live period at minimum size, N weeks, no incidents, before any size increase.

---

## 1C. LOCAL DOCKER RUNTIME + DELTA EXCHANGE INDIA (D-012)

> Owner requirements (2026-11-15): the **entire setup runs on the laptop inside Docker containers** (engine, web, database, everything). Exchange is **Delta Exchange India**: deposits in **INR**, contracts quoted/traded in **USD**.

### A. Everything in Docker (one command)
`docker compose up -d` starts the whole system. No Node, Postgres or tools need to be installed on Windows except Docker Desktop (WSL2 backend) and Git.

| Compose service | Purpose | Notes |
|---|---|---|
| `postgres` | Database | Named volume for data; healthcheck; port published to `127.0.0.1` only |
| `migrate` | One-shot `prisma migrate deploy` | Runs before engine/web (`depends_on: service_healthy / completed`) |
| `engine` | Trading engine (market data, strategy, risk, execution, paper/live) | `restart: unless-stopped`; healthcheck; no published ports |
| `web` | Next.js dashboard | Published as `127.0.0.1:3000` only; production build in "run" mode, hot-reload in "dev" mode |
| `backup` | Scheduled `pg_dump` | Writes to a host folder (e.g. `./backups`) that is also synced/copied elsewhere |

- **Profiles:** `dev` (bind-mounted source, hot reload via `docker compose watch`) and default/`run` (built images). Same images that later go to the cloud.
- **Windows specifics:** Docker Desktop set to **start on login**; repo files use **LF** line endings (`.gitattributes`); keep the repo inside the WSL2 filesystem or enable fast file sharing for acceptable performance; laptop power plan set to **never sleep while plugged in**; Windows Update active hours configured so the machine does not reboot mid-trade.
- **Secrets:** `.env` (git-ignored) + `.env.example` committed. Separate `.env.testnet` and `.env.live` so the live key is never present while developing.
- **Clock safety (critical on Windows/WSL2):** Delta rejects signed requests older than **5 seconds**, and WSL2 clocks can drift after sleep. The engine measures clock offset against the exchange server's `Date`/time response on startup and every few minutes, applies the offset to signatures, and **blocks trading** if drift exceeds a safe threshold (alert via Telegram).

### B. Delta India facts that shape the design (from official docs; re-verify when building)
| Fact | Source / status | Impact |
|---|---|---|
| Production API: `https://api.india.delta.exchange` (the `api.delta.exchange` URL is Delta **Global** and must NOT be used) | docs.delta.exchange | Base URL is a config value; guard against using the wrong region |
| Testnet/demo API: `https://cdn-ind.testnet.deltaex.org` with keys created on `demo.delta.exchange` | docs | Testnet keys only work on testnet and prod keys only on prod; use separate env files |
| BTCUSD / ETHUSD perpetuals are **quoted in USD** but **margined and settled in INR** (per docs product table) | docs | Equity, margin, PnL, drawdown and risk limits are measured in **INR**; prices and indicators are in **USD**. The engine needs an explicit money model: `price` (USD) vs `account currency` (INR). Confirm settling asset per product via `/v2/products` |
| Orders/orderbook use **product IDs**, not symbols | docs | `symbols` table stores product_id, symbol, contract value, tick size, lot size, settling asset; loaded from `/v2/products` |
| SOL availability on Delta India | **Not confirmed** | Verify a SOLUSD perpetual exists on India via `/v2/products` before committing to SOL (Stage 2 task); drop SOL from v1 if absent |
| API key permissions: **Read Data** and **Trading** (no withdrawal permission exists to grant) | docs | Create a Trading+Read key only; market data needs Read only |
| **IP whitelisting is enforced**; dynamic ISP IPs require frequent updates; docs recommend a static-IP cloud machine for production | docs | **Major risk for laptop-live:** if your home IP changes, orders fail with `ip_not_whitelisted_for_api_key`. See mitigation below |
| Signature must be < 5 s old; `User-Agent` header required (CDN blocks otherwise) | docs | Clock-offset logic above; set a User-Agent in the client |
| Cursor-based pagination on products/orders/fills | docs | `exchange-sdk` implements generic cursor pagination |
| Data centers are in AWS Tokyo | docs | Latency from India is fine for 1h/4h strategies; not for scalping |

### C. Handling a changing home IP (laptop live trading)
1. Whitelist your current public IP on the live key; prefer an ISP **static IP** option if available.
2. Engine treats `ip_not_whitelisted_for_api_key` as a **critical event**: stop placing new orders, send Telegram alert with the IP from the error response, keep retrying read-only checks, and require you to update the whitelist (manual reset).
3. Because every entry has an **exchange-side stop-loss**, an IP change cannot leave a position unprotected; it only stops new management actions (e.g., trailing stops, manual exit from the engine).
4. Do not use VPN/proxy tricks to hold a fixed IP on the laptop. If IP changes become frequent, that is the trigger to move the engine to a **static-IP VPS** (cloud migration, §7A), which is already designed to be a config change.

### D. INR/USD money model (to specify in `docs/risk/` before Stage 4)
- Account equity, margin, loss limits and drawdown: **INR** (settling asset), read from the exchange wallet/balance.
- Prices, ATR, stop distances: **USD**.
- Position size = (risk % × equity in INR) ÷ (stop distance in USD × contract value × USD/INR conversion as applied by the exchange for margin/PnL). The exact INR conversion rule used by Delta India for PnL/margin must be confirmed from the docs/testnet and encoded in `risk-core` with tests.
- Backtests report PnL in INR, using a documented fixed or historical USD/INR assumption; paper trading mirrors the exchange's own conversion behaviour as closely as verified.
- Fees, funding and any INR-specific charges (e.g., taxes/GST/TDS on Indian platforms) are **not** modelled until confirmed; list them in `docs/business/` and treat as an open item.

### E. Consequences for earlier sections
- §1B Web UI and local env: `web` also runs in a container (no host `pnpm dev` requirement).
- §1A must-decide #2 (capital/currency) is answered: **INR capital, USD-quoted contracts**; amount still needed.
- §6 open question "Starting capital & currency" is partially resolved; "Instrument type" assumed **perpetual futures**, to confirm.

---

## 1D. FIXED IP → VPS PLAN (D-013)

> Owner decision (2026-11-15): a **fixed IP is mandatory** for live trading. Therefore **live trading runs on a VPS**, not the laptop. This supersedes the "live from laptop" allowance in D-011/§1B (laptop = dev, backtest, testnet and paper only).

### Where each thing runs
| Activity | Laptop (Docker) | VPS (Docker) |
|---|---|---|
| Development, tests, backtests | ✅ | — |
| Public market data (no API key needed) | ✅ | ✅ |
| Paper trading | ✅ (short runs) | ✅ **preferred for the 4-week paper gate** (24/7, no sleep) |
| Delta **testnet** orders | ✅ | ✅ |
| **Live orders (real key, IP-whitelisted)** | ❌ never | ✅ only |
| Dashboard | `127.0.0.1:3000` | reached via private tunnel (below) |

### Timing: when to get the VPS online
- **Not needed yet** for Stages 1–3 (foundation, market data, research/backtest).
- **Bring it online at the start of Stage 4 (risk + paper)** so the ≥4-week paper soak runs 24/7 on the same machine, with the same images and fixed IP that live will use. This also rehearses deployment before real money is involved.
- Live arming (Stage 6) = flip the live key + `TRADING_MODE` on the VPS only after the paper gate passes.

### First checks before committing to Contabo (do these on day 1 of Stage 4)
1. **Does Delta India accept API traffic from the VPS's country/IP?** Delta India serves Indian users; a foreign datacenter IP might be blocked or restricted. Test from the VPS: `curl https://api.india.delta.exchange/v2/products` and a signed testnet call. Also confirm in Delta support/docs that API keys can be whitelisted to a non-Indian IP.
2. If blocked or doubtful, fallback to a VPS with an **Indian static IP** (e.g. AWS Mumbai with Elastic IP, DigitalOcean Bangalore, Oracle Cloud Mumbai). The design is provider-agnostic: it is just Docker on Linux.
3. Choose the datacenter closest to Delta's servers (AWS Tokyo) **only if** check 1 passes; otherwise prioritise acceptance over latency (1h/4h strategies don't need low latency).

### VPS setup (target: Ubuntu 24.04 LTS, ~4 vCPU / 8 GB is ample)
1. Create non-root sudo user, **SSH key-only login**, disable password login and root login.
2. Firewall (`ufw`): default deny inbound; allow only SSH (ideally restricted to your IP or via Tailscale). **No 80/443, no public dashboard.**
3. `fail2ban`, unattended security upgrades, **`chrony`** time sync (signature window is 5 s).
4. Docker Engine + Compose plugin; Docker log rotation configured.
5. Clone repo, create `.env.live` (root-only file permissions), `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`.
6. Backups: nightly `pg_dump` pushed **off the VPS** (to your laptop/cloud storage) plus Contabo snapshots.
7. Heartbeat to an external monitor (e.g. Healthchecks.io) and Telegram alerts for engine down/up.

### Accessing the dashboard (no login by design, so never public)
Recommended: **Tailscale** (free personal tier) on the VPS and laptop/phone; dashboard binds to the Tailscale interface or `127.0.0.1` and is opened via the private network. Alternative: SSH tunnel (`ssh -L 3000:127.0.0.1:3000 user@vps`). If you ever want a public URL, authentication becomes mandatory first.

### Deploying (MVP: keep it simple)
- Manual: SSH → `git pull` → `docker compose ... up -d --build`, via a small `scripts/deploy.sh`.
- Later (post-MVP): GitHub Actions builds images → GHCR → VPS pulls; rollback by image tag.

### Live key handling on VPS
Trade+Read key only, whitelisted to the VPS IP, stored only in `.env.live` on the VPS (never in git, never on the laptop). Rotate if the VPS is ever suspected compromised.

### Cost
Contabo VPS (monthly, already owned) + free tools (Tailscale, Healthchecks, GitHub). No other recurring cost for the MVP.

---

## 2. Vision & Success Criteria

A production-grade **automated crypto trading operating system** (not a single bot), made of: Market Data, Research, Strategy, Risk, Execution, Portfolio, Analytics, AI Review, Trade Journal and Monitoring platforms. Must be maintainable, modular, scalable, easy to extend. **Documentation-first.**

**Success is:** capital preservation, controlled drawdowns, consistent execution & position sizing, reliable infrastructure, full observability, no emotional decisions, easy maintenance.
**Success is NOT:** highest returns, most trades, most indicators.

---

## 3. Master Spec (v1.0 baseline)

### 3.1 Assets & Exchanges
| | Initial | Future |
|---|---|---|
| Assets | BTC, ETH, SOL | Stocks, Forex, Commodities, Indices |
| Exchanges | Delta Exchange | Binance, Bybit, Zerodha, Interactive Brokers |

Exchange Adapter Pattern is mandatory. **No service may depend directly on Delta.**

### 3.2 Technology Stack
| Layer | Choice |
|---|---|
| Frontend | Next.js, React, TypeScript, Tailwind, ShadCN UI, React Query, Zustand, Recharts |
| Backend | NestJS, TypeScript, Prisma, BullMQ |
| Database | Neon PostgreSQL |
| Cache | Upstash Redis |
| Infra | Contabo VPS, Docker, Docker Compose, Nginx Proxy Manager, Let's Encrypt |
| CI/CD | GitHub, GitHub Actions |
| Hosting (UI) | Cloudflare Pages |
| Notifications | Telegram |
| Monitoring | Grafana Cloud Free, Loki |
| AI | OpenAI or Azure OpenAI |

### 3.3 Architecture Principles
1. Risk first 2. Event-driven 3. Modular services 4. Exchange agnostic 5. Documentation first
6. Audit everything 7. Test everything 8. UI separate from trading engine 9. No tight coupling 10. Simple before smart

### 3.4 Documentation Structure
```
docs/
  architecture/ business/ database/ infrastructure/ services/ api/ frontend/
  risk/ strategies/ ai/ testing/ monitoring/ prd/ decisions/ tasks/
```
Mandatory files: `MASTER_PROJECT_SPECIFICATION.md`, `ai-context.md`, `project-constitution.md`, `system-overview.md`, `schema.md`, `service-map.md`, `roadmap.md`

### 3.5 Monorepo Structure
```
apps/      web, api-gateway, market-data, indicator-engine, strategy-engine, market-regime,
           risk-engine, execution-engine, portfolio-engine, ai-engine, paper-trader,
           backtester, notifications
packages/  shared-types, shared-events, shared-utils, exchange-sdk, indicator-core,
           strategy-core, risk-core, ui-components
```

### 3.6 Database Tables
users, accounts, symbols, candles, ticks, funding_rates, open_interest, indicators, signals, orders, fills, positions, trades, trade_reviews, portfolio_snapshots, risk_events, backtests, paper_trades, notifications, audit_logs, system_health

### 3.7 Services
| Service | Responsibilities |
|---|---|
| Market Data | websocket handling, Delta integration, reconnect logic, candle generation, historical sync |
| Indicator Engine | EMA, SMA, RSI, MACD, ATR, VWAP, BBANDS, ADX, SuperTrend |
| Market Regime | trending, ranging, breakout, volatile, dead |
| Strategy Engine | plugin architecture; every strategy implements a common interface |
| Risk Engine | most important; the **only gatekeeper**; no bypass |
| Execution Engine | the **only** service that talks to the exchange |
| Portfolio Engine | exposure & allocation management |
| AI Review Engine | reviews, scores, explains trades; **never executes** |

### 3.8 Risk Rules (hard limits)
| Rule | Limit |
|---|---|
| Risk per trade | 0.5% |
| Max daily loss | 2% |
| Max weekly loss | 5% |
| Max monthly loss | 10% |
| Max drawdown | 12% |
| Max open positions | 3 |
| Max asset exposure | 20% |
| Max leverage | 3x |

**On any breach:** disable trading → create risk event → Telegram alert → require manual reset.

### 3.9 UI
Pages: Dashboard, Markets, Strategies, Signals, Portfolio, Risk Center, AI Insights, Trade Journal, Backtesting, Paper Trading, Live Trading, Settings.
Risk Command Center shows: Equity, Drawdown, Exposure, Leverage, Daily Risk, Weekly Risk, Kill Switch, Trading Status, Emergency Stop.

### 3.10 Code Quality & Maintainability
SOLID, DDD, Clean Architecture, Repository pattern, feature-based modules, strict TypeScript, ≥80% coverage, reusable components, shared libs, no duplicated business logic.
Every module has: interfaces, tests, docs, API contracts, health checks. Services talk via events. Shared libs for: risk calculations, exchange contracts, indicators, domain models.

### 3.11 Implementation Phases
| # | Phase |
|---|---|
| 1 | Documentation + Architecture |
| 2 | Infrastructure + CI/CD |
| 3 | Market Data Platform |
| 4 | Indicators + Storage |
| 5 | Strategy Framework |
| 6 | Backtesting |
| 7 | Risk Engine |
| 8 | Paper Trading |
| 9 | Dashboard |
| 10 | Live Trading |
| 11 | AI Review Layer |

### 3.12 Copilot Execution Rules
Before code: 1) read MASTER_PROJECT_SPECIFICATION.md 2) read ai-context.md 3) read related service docs 4) update docs 5) create tests 6) create interfaces 7) implement 8) update docs 9) update ai-context. **If docs and code disagree, docs win.**

---

## 4. Discussion Log
_Newest first. Capture the question, options considered, and outcome._

| Date | Topic | Summary | Outcome |
|---|---|---|---|
| 2026-11-15 | Fixed IP → VPS | Owner needs a fixed IP; live moves to VPS, VPS online at Stage 4; must first verify Delta India accepts the VPS IP. See §1D. | D-013 (Proposed) |
| 2026-11-15 | Docker-only + Delta India | Whole stack in Docker on laptop; Delta India specifics (INR settlement, IP whitelist, 5 s signature window, India vs Global URLs) added in §1C. | D-012 (Proposed) |
| 2026-11-15 | Local-only, live orders, ETH/SOL | Owner removed login/2FA (local only) and added live orders + ETH/SOL to MVP. Updated §1B with guardrails for live-from-laptop. | D-011 (Proposed) |
| 2026-11-15 | MVP services and stack | Defined MVP scope, module list, out-of-scope list, tech choices with reasons, tables and exit gates. See §1B. | D-010 (Proposed) |
| 2026-11-15 | Reset: one clear plan | Owner confused by multiple options. Consolidated into a single blueprint (§1A). | D-009 (Proposed) |
| 2026-11-15 | Minimal stack (Next.js + Vercel + Supabase + Delta) | Vercel can't run a persistent engine or give a static IP; recommended hybrid with one VPS engine container. See §7D. | D-008 (Proposed) |
| 2026-11-15 | Simplify & harden | Too many moving parts (13 apps, 9+ vendors). Proposed modular monolith, fewer vendors, hardened trading path. See §7C. | D-007 (Proposed) |
| 2026-11-15 | Tech stack plan | Per-layer plan for local vs cloud, with gaps in the original stack flagged. See §7B. | D-006 (Proposed) |
| 2026-11-15 | Laptop → cloud path | Develop locally on laptop, deploy same containers to cloud later. See §7A. | D-004 (Accepted) |
| 2026-11-15 | Kick-off | Master spec v1.0 supplied by owner; decided to create this planning file first and later reuse it as phase-wise agent prompts. | Created `root_planning.md` |

---

## 5. Decision Log (ADR index)
_Format: `D-NNN | date | decision | rationale | status (Proposed/Accepted/Superseded)`_

| ID | Date | Decision | Rationale | Status |
|---|---|---|---|---|
| D-001 | 2026-11-15 | Documentation-first; docs override code | Owner mandate in spec | Accepted |
| D-002 | 2026-11-15 | `root_planning.md` is the planning source until docs/ exists | Keeps discussions in one place | Accepted |
| D-003 | 2026-11-15 | Stack, services, risk limits and phase order as per §3 baseline | Owner-supplied spec v1.0 | Accepted (subject to §6 review) |
| D-004 | 2026-11-15 | Local-first development on laptop with Docker Compose; identical images promoted to Contabo VPS; only env config differs. Live trading never runs from the laptop. | Zero rewrite at migration; laptop is not 24/7 and must not hold live keys | **Accepted** (live-on-laptop restriction relaxed by D-011 with guardrails) |
| D-005 | 2026-11-15 | Docker is confirmed for all services, local and cloud | Owner confirmation | **Accepted** |
| D-006 | 2026-11-15 | Remaining stack choices follow the plan in §7B (pending owner confirmation per row) | See §7B | Superseded by D-009 |
| D-007 | 2026-11-15 | Simplify to a modular monolith with 3 deployables, 1 Postgres, 1 Redis, 1 proxy; harden the trading path (see §7C). Overrides the 13-app layout in §3.5 and trims §7B | Fewer moving parts = fewer failure modes; boundaries stay enforced in code so services can be split later | Superseded by D-009 |
| D-008 | 2026-11-15 | Minimal stack: Next.js on Vercel + Supabase + Delta; for live trading add ONE outbound-only engine container on the VPS (Option B, §7D). Pure serverless (Option A) only for paper/slow strategies | Vercel cannot hold persistent websockets or a static IP; engine needs both | Superseded by D-009 (its Option B is adopted inside D-009) |
| D-009 | 2026-11-15 | Adopt the FINAL BLUEPRINT in §1A: 2 deployables (Next.js `web` on Vercel, Node/TS `engine` in Docker), Supabase, risk-first safety design, staged build path with exit gates, v1 = BTC + 1 strategy + paper first | Owner confused by competing options; one simple, standard, safe path | **Proposed** (becomes Accepted once §1A "must-decide" items are answered) |
| D-010 | 2026-11-15 | MVP = Stages 1–5 of §1A: BTC, 1 strategy, paper trading only, full risk gate, Telegram, minimal dashboard with kill switch; stack per §1B | Smallest system that proves edge and safety before any real money | **Proposed** (amended by D-011) |
| D-011 | 2026-11-15 | MVP runs locally only, no login/2FA (localhost-bound); live orders and ETH/SOL are added to the MVP; Supabase/Vercel/VPS deferred to cloud migration; live from laptop allowed only with the §1B guardrails and after the paper gate | Owner request. Local-only removes auth/cloud scope; live-on-laptop risk is mitigated by exchange-side stops, reconciliation, minimum size, paper gate | **Proposed** (superseded in part by D-013: live runs on VPS, not laptop) |
| D-012 | 2026-11-15 | Whole system runs in Docker on the laptop (`docker compose up`); exchange = **Delta Exchange India** (INR margin/settlement, USD-quoted contracts); money model, clock-drift guard and IP-whitelist handling per §1C | Owner requirement; Delta India docs enforce IP whitelisting, 5 s signature window and INR settlement | **Proposed** |
| D-013 | 2026-11-15 | Fixed IP required → **live trading runs only on a VPS** (Docker, Ubuntu, key-only SSH, no public ports, dashboard via Tailscale/SSH tunnel). Laptop = dev/backtest/testnet/paper. VPS brought online at start of Stage 4 (paper soak) after verifying Delta India accepts the VPS IP | Delta enforces IP whitelisting; home IP is dynamic; 24/7 paper soak needs an always-on host | **Proposed** |
| D-014 | 2026-11-15 | Configurable timeframes 5m / 15m / 30m / 1h / 4h per symbol via `config/strategies.yaml`; 5m base candles with aggregation; one active position per symbol; each symbol×timeframe must pass its own backtest/paper gate | Owner requirement; shorter timeframes raise cost drag and whipsaw risk, so evidence per timeframe is required | **Proposed** |
| D-015 | 2026-11-15 | VPS is part of the MVP: Contabo **India (Mumbai)** region, entry Cloud VPS (4 vCPU / 8 GB / 100 GB SSD, ~EUR 5.50/mo, confirm at checkout), Ubuntu 24.04, dedicated IPv4 as the whitelisted IP. Prompt 8 (VPS deploy + paper soak) is in MVP; Prompt 9 (live arming) is gated | Contabo has an India DC (resolves the foreign-IP concern in §1D); workload is light; owner already has Contabo | **Proposed** |

---

## 6. Open Questions & Points to Review
_Items I'd suggest settling before Phase 1 prompts are generated. Mark each Resolved with a D-ID._

### Architecture / Infra
- [ ] **Event bus:** spec says "event-driven" but only lists BullMQ + Upstash Redis. Confirm: BullMQ queues + Redis Streams/Pub-Sub? Upstash bills per command and BullMQ is chatty — consider self-hosted Redis on the Contabo VPS instead (or both: Upstash only for cache).
- [ ] **Neon for ticks:** high-frequency `ticks`/`candles` writes may be costly/latent on Neon free tier. Options: store only candles in Neon, keep ticks in Redis/in-memory with short TTL, or use TimescaleDB on the VPS.
- [ ] **Where does each piece run?** UI on Cloudflare Pages; 13 apps on one Contabo VPS via Docker Compose? Confirm VPS size and whether all engines run as separate containers or some are merged initially (e.g. indicator + regime + strategy).
- [ ] **Next.js on Cloudflare Pages:** needs the Cloudflare adapter (edge runtime limits). Confirm static/edge-only UI that calls the API gateway.
- [ ] **Auth model:** single owner (you) or multi-user? Spec has `users` table but no auth approach (JWT, passkeys, Cloudflare Access?). API gateway must be locked down — it can control live money.
- [ ] **Secrets:** where do exchange API keys live (VPS env, Docker secrets, Vault, GitHub encrypted secrets)? Keys should be trade-only, no withdrawal permission, IP-whitelisted.
- [ ] **Monorepo tooling:** pnpm + Turborepo or Nx? (Not specified.)

### Trading / Risk
- [ ] **Instrument type:** Delta Exchange perpetual futures vs. options vs. spot? Affects leverage, funding, margin, sizing math.
- [ ] **Risk math consistency:** 3 positions × 0.5% risk = 1.5% simultaneous risk (< 2% daily cap — fine) but 3 positions × 20% asset exposure with 3x leverage needs a defined basis (notional vs margin, % of equity). Define exact formulas in `docs/risk/`.
- [ ] **Loss windows:** daily/weekly/monthly measured in which timezone (UTC vs IST) and on realized only or realized + unrealized PnL?
- [ ] **Drawdown basis:** from peak equity (high-water mark) or from starting balance? Does a manual reset re-baseline it?
- [ ] **Starting capital & currency:** USDT / USD / INR? Affects minimum position size vs. exchange minimum contract sizes.
- [ ] **Stop-loss ownership:** exchange-side bracket orders (survive VPS outage) vs. engine-managed? Recommend exchange-side always.
- [ ] **Kill switch behaviour:** on breach, flatten open positions or only block new entries?
- [ ] **First strategies:** which 1–2 strategies seed the Strategy Framework (e.g. EMA trend-follow, breakout)? Which timeframes?
- [ ] **Promotion gate:** minimum backtest + paper-trading criteria (duration, trades, max DD, expectancy) before a strategy may go live.

### Product / Process
- [ ] **AI engine scope:** post-trade review only (per spec), or also pre-trade commentary? OpenAI vs Azure OpenAI choice; cost cap.
- [ ] **Notifications:** Telegram only; which events (fills, risk events, health, daily summary)?
- [ ] **Backups & DR:** Neon branching/PITR, VPS snapshots, restart/reconciliation behaviour (positions on exchange vs DB).
- [ ] **Compliance/tax:** India-based exchange access and tax-reporting export needs (trade journal CSV)?
- [ ] **Coverage target scope:** 80% overall, or higher (e.g. 95%) for `risk-core` and `execution-engine`?

---

## 7. Assumptions & Constraints
- Single owner/operator initially.
- Live trading is gated behind paper trading and risk engine (Phases 7 → 8 → 10); no live order path may exist without passing the Risk Engine.
- Capital preservation outranks any feature or performance goal.
- Everything auditable: all decisions, signals, orders and risk events persist to `audit_logs`.

---

## 7A. Environment Strategy: Laptop → Cloud (D-004, Accepted)

**Principle:** build once, configure per environment. Same Docker images everywhere (12-factor); only environment variables change.

### Environments
| Env | Where | Database | Redis | Exchange | Trading mode |
|---|---|---|---|---|---|
| `local` | Laptop, Docker Compose | Postgres container | Redis container | Delta testnet / mocked adapter | `paper` only |
| `staging` | Contabo VPS (optional) | Neon branch | Upstash or VPS Redis | Delta testnet | `paper` |
| `prod` | Contabo VPS + Cloudflare Pages | Neon main | Upstash or VPS Redis | Delta live (restricted key) | `paper` → `live` after gate |

### Rules that make the move painless
1. **Everything in Docker Compose from day 1** (`docker-compose.yml` + `docker-compose.local.yml` / `docker-compose.prod.yml` overrides). No "works on my machine" services.
2. **Config only via env vars** (`DATABASE_URL`, `REDIS_URL`, `EXCHANGE_ADAPTER`, `EXCHANGE_BASE_URL`, `TRADING_MODE`). Commit `.env.example`, never `.env`.
3. **Exchange behind the adapter**: `EXCHANGE_ADAPTER=delta-testnet | delta-live | mock`. Local uses testnet/mock.
4. **Hard safety guard:** `TRADING_MODE=live` is refused unless running in `prod` with live keys present. Live API keys are never stored on the laptop.
5. **Prisma migrations** are the only way schema changes; same migrations run locally and on Neon (`prisma migrate deploy`).
6. **Build in CI, not on the VPS:** GitHub Actions builds images → pushes to GHCR → VPS pulls and restarts (`docker compose pull && up -d`). Laptop and VPS then run byte-identical images.
7. **Data is disposable:** don't migrate local candles; re-run the historical sync in the cloud. Only configs/strategy params travel (in git).

### Migration checklist (when Phases 1–8 work locally)
1. Create Neon project → set `DATABASE_URL` → `prisma migrate deploy`.
2. Create Upstash Redis (or Redis on VPS) → set `REDIS_URL`.
3. Provision Contabo VPS: harden SSH (keys only), firewall (80/443 + SSH), install Docker, Docker Compose, Nginx Proxy Manager.
4. DNS on Cloudflare → NPM proxy hosts → Let's Encrypt certs.
5. GitHub Actions: add secrets (SSH key, GHCR token, env values); workflow builds, pushes, deploys.
6. Deploy `web` to Cloudflare Pages, pointing at the API gateway URL.
7. Run in cloud in `paper` mode for the agreed soak period; check Grafana/Loki, Telegram alerts, restart/reconnect behaviour.
8. Create trade-only, IP-whitelisted, no-withdrawal live key; store on VPS only; flip to `live` after the promotion gate (§6).

### Caveats
- Laptop sleeps/loses network → fine for dev, **unsafe for live**; any live position must have exchange-side stops.
- Cloud-only services (Neon, Upstash, Grafana) can be used from the laptop too, but local containers are free and faster; use them in `local`.

---

## 7B. Tech Stack Plan (D-006, Proposed — confirm row by row)

Docker is the runtime everywhere (D-005). Below: what runs locally, what runs in the cloud, and my recommendation.

| Layer | Local (laptop, Docker) | Cloud (prod) | Recommendation / note |
|---|---|---|---|
| Runtime & tooling | Node 22 LTS, **pnpm + Turborepo** | same (in images) | Gaps in original spec: monorepo tool and package manager were not named. Add ESLint, Prettier, Husky, Conventional Commits. |
| Backend | NestJS apps in containers (hot reload via compose watch) | same images on VPS | Each `apps/*` service is its own Nest app and container. Start with the minimum containers and split later if needed. |
| Contracts / validation | Zod (or class-validator) + OpenAPI | same | Typed events in `shared-events`, API contracts in `docs/api`. |
| Database | Postgres container (same major version as Neon) | **Neon** (pooled URL at runtime, direct URL for migrations) | One Prisma schema owned by a single shared package; services use repositories, never raw cross-service table access. Raw ticks are **not** stored in Neon. |
| ORM | Prisma | Prisma | Run `prisma migrate deploy` in CI/deploy step. |
| Redis / queues | Redis container | Redis on the VPS (preferred) or Upstash | BullMQ for jobs (backtests, AI reviews, notifications). Redis Streams or pub/sub for the event bus. Upstash per-command billing is a risk for BullMQ. |
| Exchange | `mock` or Delta testnet adapter | Delta live adapter | `packages/exchange-sdk` defines the contract. Execution Engine is the only caller. |
| Frontend | Next.js dev server (container or host) | **Cloudflare Pages** | Next.js on Pages needs the OpenNext Cloudflare adapter, or a static/client-rendered build calling the API. Fallback: run `web` on the VPS initially and move to Pages later. |
| UI libs | Tailwind, ShadCN, React Query, Zustand | same | **Recharts is not suited to candlestick charts**: add TradingView Lightweight Charts for price charts; keep Recharts for equity/drawdown/stat charts. |
| Realtime to UI | WebSocket/SSE from api-gateway | same behind Nginx Proxy Manager | Needs sticky/long-lived connection support in the proxy config. |
| Auth | Simple local owner login | JWT + 2FA (TOTP), optionally Cloudflare Access in front | Single-user to start. API gateway can control real money, so lock it down. |
| Notifications | Separate **dev** Telegram bot/chat | Prod bot/chat | Never share tokens across environments. |
| AI | Mock provider or a cheap model | OpenAI or Azure OpenAI | Provider interface in `ai-engine`; add monthly cost cap. Reviews only, never trade execution. |
| Logging | pino JSON logs to stdout | Loki via Grafana Alloy/Promtail agent | Optional compose profile `observability` to run Grafana + Loki locally. |
| Metrics / health | `/health` + `/metrics` on every service | Grafana Cloud | Alerts routed to Telegram. |
| Testing | Vitest (packages), Jest (Nest), Playwright (UI), Testcontainers or compose for integration | run in GitHub Actions | 80% minimum; propose higher bar for `risk-core` and `execution-engine`. |
| CI/CD | `pnpm` scripts, pre-commit hooks | GitHub Actions: lint → typecheck → test → build images → push **GHCR** → SSH deploy to VPS | Build in CI, never on VPS. Tag images by git SHA for rollback. |
| Reverse proxy / SSL | none (localhost ports) | Nginx Proxy Manager + Let's Encrypt, Cloudflare DNS | Only 80/443/SSH open; internal services not exposed. |
| Secrets | `.env` (git-ignored) | GitHub Actions secrets + VPS `.env`/Docker secrets | Live exchange key only on VPS, trade-only, IP-whitelisted. |
| Indicators / backtester | `indicator-core`, `strategy-core`, `risk-core` shared libs | same | Backtester, paper trader and live engine must use the **same** strategy and risk libs so results match. Validate indicators against a reference library. |

### Stack gaps in the original spec (to decide)
1. Monorepo tool (pnpm + Turborepo proposed).
2. Event bus technology (Redis Streams proposed).
3. Candlestick charting library (Lightweight Charts proposed).
4. Auth approach.
5. Time-series storage for ticks (Redis short TTL / not persisted proposed).
6. Backups and disaster recovery (Neon PITR + VPS snapshots).

---

## 7C. Simplification & Robustness Plan (D-007, Proposed)

**Idea:** keep the *logical* architecture (modules, events, interfaces, risk-first) but collapse the *physical* one. Split into separate services only when a real need appears.

### 1. Modular monolith instead of 13 apps
Original 13 apps become **3 deployables** (all Docker):

| Deployable | Contains | Why separate |
|---|---|---|
| `web` | Next.js UI | UI must never affect trading (principle 8) |
| `api` | NestJS: REST/WebSocket for UI, auth, settings, journal, backtest and AI-review jobs, notifications | Can be restarted/deployed freely |
| `engine` | NestJS: market-data → indicators → regime → strategy → **risk → execution** → portfolio | The critical loop; deployed rarely, restarted safely |

Inside `engine`/`api` the former services are **NestJS modules** with strict boundaries (own folder, public interface only, lint rule forbidding cross-module deep imports) and talk through a typed in-process event bus (`EventBus` interface in `shared-events`). If a module ever needs its own container, swap the bus implementation to Redis Streams without changing module code.

Backtester and paper-trader are **modes/adapters** of the same engine code (simulated exchange adapter + replay data source), not separate apps. This guarantees backtest = paper = live logic.

### 2. Fewer packages
`packages/`: `core` (domain models, types, events, utils), `exchange-sdk`, `trading-core` (indicators + strategies + regime), `risk-core` (isolated, highest coverage bar), `ui-components`. (8 → 5.)

### 3. Fewer vendors / infra pieces
| Original | Simplified | Reason |
|---|---|---|
| Nginx Proxy Manager + Let's Encrypt | **Caddy** (auto-HTTPS, ~5 lines of config) or Cloudflare Tunnel | One small config file, no GUI to maintain |
| Cloudflare Pages for UI | **`web` container on the VPS**, Cloudflare for DNS/proxy only | One deployment target, no Next.js-on-edge adapter issues. Can move to Pages later |
| Upstash Redis | **Redis container** in the same compose file | Same as local, no per-command billing |
| Neon | Keep Neon **or** Postgres container on the VPS + nightly `pg_dump` to Cloudflare R2/other storage | Decide in §6. Neon = managed backups, but check free-tier compute limits and scale-to-zero latency; VPS Postgres = identical to local, simplest |
| Grafana Cloud + Loki from day one | Start with structured logs, `/health`, Telegram alerts and an external heartbeat check (e.g. Healthchecks.io); add Grafana/Loki in a later phase | Observability proportional to maturity |
| BullMQ everywhere | BullMQ only for long jobs (backtests, AI reviews); trading loop uses no queue | Keeps the hot path simple and low-latency |

Resulting runtime on the VPS: **Caddy + web + api + engine + Redis (+ Postgres if self-hosted)** = 5–6 containers.

### 4. Robustness rules for the trading path (fail-closed)
1. **Risk cannot be bypassed by design:** `ExecutionService.place()` accepts only an order carrying a `RiskApproval` issued by `risk-core` (signed/typed token), called **synchronously** — not an async event that could be skipped.
2. **Kill switch is persisted** (DB flag) and checked before every order; if the flag can't be read, **block the order**.
3. **Exchange is the source of truth:** on every start and periodically, reconcile positions/orders/balance from the exchange before trading resumes.
4. **Idempotent orders:** deterministic client order IDs, so retries/restarts never double-submit.
5. **Exchange-side stop-loss** on every entry (bracket order); the engine is not the only protection.
6. **Single-instance lock** for the engine (prevents two copies trading).
7. **Stale-data guard:** no signals/orders if market data is older than N seconds or the websocket is down.
8. **Restart policy** `unless-stopped`, health checks, and a **dead-man heartbeat**: no heartbeat → Telegram alert.
9. **Money math:** decimal types (no floats) for prices, quantities, PnL.
10. **Dry-run by default:** `TRADING_MODE=paper` unless explicitly set otherwise in prod.
11. **Audit trail:** every signal → risk decision → order → fill persisted with a correlation ID.

### 5. Scope simplification (vertical slice first)
- **MVP:** BTC only → 1 strategy → paper trading → minimal UI (Dashboard, Risk Center, Trades). Then add ETH/SOL, more strategies, remaining pages.
- **Tables for MVP (~10):** users, symbols, candles, signals, orders, fills, positions, trades, risk_events, audit_logs. Add the rest (ticks, funding_rates, open_interest, indicators, trade_reviews, portfolio_snapshots, backtests, paper_trades, notifications, system_health, accounts) when their phase needs them. Indicators are computed, not stored, until performance requires it.
- **Docs:** keep all mandatory files but short; one ADR per decision; prefer diagrams/tables to prose.
- **Phase order tweak:** build the engine + risk + paper loop (Phases 3–8) as one thin slice end-to-end before polishing the dashboard.

### Before → After
| | Before | After |
|---|---|---|
| Apps | 13 | 3 |
| Packages | 8 | 5 |
| Vendors/services | ~10 | ~4 (GitHub, Cloudflare DNS, Telegram, DB option) |
| Prod containers | 13+ plus proxy | 5–6 |
| Architecture rules | unchanged | unchanged, enforced by module boundaries |

---

## 7D. Minimal-Stack Option: Next.js + Vercel + Supabase + Delta (D-008, Proposed)

**Owner idea:** use only Next.js, Vercel for deployment, Delta Exchange for market data, Supabase as database.

### Key finding: what Vercel can and cannot do here
| Need | Vercel (serverless) | Impact |
|---|---|---|
| Host UI + API routes | ✅ Excellent | Use it for `web` |
| Long-running process / persistent Delta websocket | ❌ Functions are short-lived | No tick-by-tick engine on Vercel |
| Scheduled jobs | ⚠️ Hobby: cron once/day only; Pro: down to 1/min | Candle-close strategies need a better scheduler |
| Static outbound IP for Delta API key whitelisting | ⚠️ Dynamic IPs by default; static IPs are a paid feature | Verify Delta's current IP-whitelist rule for trading keys |
| Commercial use | ⚠️ Hobby plan is non-commercial | Fine for personal use; check terms |

So a **pure Vercel** system is only viable for **slow, candle-close strategies** (e.g. 1h/4h/daily) with a paid scheduler, exchange-side stop-losses on every entry, and a solution for the Delta IP whitelist. It cannot do reliable continuous monitoring (kill switch, drawdown checks, reconnects).

### Option A — Pure serverless (Vercel + Supabase)
- Scheduler: Vercel Cron (Pro) or Supabase `pg_cron` calling a protected API route, or an external cron service.
- Engine = API routes that fetch candles via Delta REST, run strategy → risk → order, then exit.
- Risks: missed/late runs, cold starts, IP whitelist problem, harder to guarantee "kill switch within seconds".
- Good for: paper trading, backtesting, journaling, dashboards, AI reviews.

### Option B — Hybrid (RECOMMENDED for live trading)
```
Browser ──> Vercel (Next.js UI + light API routes) ──> Supabase (Postgres, Auth, Realtime, RLS)
                                                          ▲   │ (commands: kill switch, settings)
                                                          │   ▼
                                  Contabo VPS: ONE Docker container "engine"
                                  (Node/TS worker; outbound-only connections)
                                          │
                                          ▼
                                    Delta Exchange (REST + WS)  ── Telegram alerts
```
- The only always-on piece is **one small engine container** on the existing Contabo VPS (fixed IP for Delta whitelist, persistent websocket, risk loop, reconciliation).
- **No inbound ports** on the VPS: engine only makes outbound calls (Delta, Supabase, Telegram). No proxy, no SSL, no public attack surface.
- UI ↔ engine communicate through Supabase tables (`commands`, `settings`, `risk_events`, `positions`…) and Realtime. Kill switch = a row the engine watches and also checks before every order.
- Redis dropped. Caddy/NPM dropped. NestJS optional (plain TypeScript worker is enough); keep module boundaries and the robustness rules from §7C.

### What is required beyond Next.js + Vercel + Supabase + Delta
| Item | Needed? | Notes |
|---|---|---|
| Always-on worker host | **Yes (Option B)** | Existing Contabo VPS + Docker; local Docker on laptop for dev (D-004/D-005) |
| Supabase Auth | Yes | Replaces custom auth; enable email + TOTP MFA; single owner account; RLS on every table |
| Supabase service-role key | Engine only | Never in browser/Vercel client code; engine and server routes only |
| Telegram bot | Yes | Alerts: risk events, fills, health; separate dev/prod bots |
| Delta API keys | Yes | Trade-only, no withdrawal, IP-whitelisted; stored only on VPS (live) |
| Delta testnet/demo | Yes | For local dev and paper validation |
| Scheduler | Option A only | Vercel Cron (Pro) / pg_cron / external |
| Heartbeat monitor (e.g. Healthchecks.io) | Yes | Engine pings; no ping → Telegram/email alert |
| Error tracking (Sentry free) | Recommended | UI + engine |
| GitHub + Actions | Yes | Lint/test; build engine image → GHCR → VPS pulls; Vercel auto-deploys `web` from GitHub |
| Backups | Yes | Supabase free tier has no point-in-time recovery: nightly `pg_dump` (GitHub Action or VPS cron) to separate storage |
| AI provider | Later | OpenAI/Azure OpenAI for post-trade review only |
| Charts | Yes | Browser can connect to Delta's public websocket directly for live prices; TradingView Lightweight Charts for candles |

### Supabase free-tier cautions
- Project **pauses after ~1 week of inactivity** (the engine's activity should prevent it, but verify); free tier has limited DB size and no PITR.
- Use the pooled connection string from serverless code; direct connection from the engine.
- Keep **tick data out of the DB** (in memory in the engine; persist candles only).
- Moving to Pro (~$25/mo) before live trading with real capital is advisable (backups, no pausing).

### Resulting footprint
| Piece | Count |
|---|---|
| Deployables | 2 (`web` on Vercel, `engine` container on VPS) |
| Managed services | Vercel, Supabase, Telegram, Healthchecks (+ Sentry) |
| Monorepo | `apps/web`, `apps/engine`; `packages/core`, `exchange-sdk`, `trading-core`, `risk-core` |

If accepted, D-008 supersedes the infra parts of D-006/D-007 (Neon/Upstash/Caddy/Cloudflare Pages/Redis). The module boundaries and fail-closed robustness rules in §7C still apply.

---

## 8. Phase-wise Agent Prompts
> **Superseded by [MVP_BUILD_PROMPTS.md](./MVP_BUILD_PROMPTS.md)** (final architecture + prompts 1–9). The template and table below are kept for reference only.
_To be generated once §6 is resolved. Each prompt will follow this template and be pasted into the Copilot Agent one phase at a time._

### 8.0 Prompt template
```
ROLE: Principal Quant Architect / Staff Engineer for Sunny Crypto Manager.
CONTEXT: Read docs/MASTER_PROJECT_SPECIFICATION.md, docs/ai-context.md and docs relevant to this phase first.
PHASE: <number + name>
GOAL: <one paragraph>
SCOPE (in): <list>
SCOPE (out): <list — do not start later phases>
DELIVERABLES: <docs, interfaces, tests, code, CI changes>
CONSTRAINTS: Risk-first, exchange-agnostic, event-driven, strict TS, ≥80% coverage, docs win over code.
PROCESS: update docs → write tests → define interfaces → implement → update docs → update ai-context.md
ACCEPTANCE CRITERIA: <verifiable checklist>
STOP CONDITION: Report summary + open questions; do not proceed to next phase.
```

### 8.1 Phase prompts
| Phase | Name | Prompt status |
|---|---|---|
| 1 | Documentation + Architecture | ⬜ Not drafted |
| 2 | Infrastructure + CI/CD | ⬜ Not drafted |
| 3 | Market Data Platform | ⬜ Not drafted |
| 4 | Indicators + Storage | ⬜ Not drafted |
| 5 | Strategy Framework | ⬜ Not drafted |
| 6 | Backtesting | ⬜ Not drafted |
| 7 | Risk Engine | ⬜ Not drafted |
| 8 | Paper Trading | ⬜ Not drafted |
| 9 | Dashboard | ⬜ Not drafted |
| 10 | Live Trading | ⬜ Not drafted |
| 11 | AI Review Layer | ⬜ Not drafted |

---

## 9. Changelog
| Date | Change |
|---|---|
| 2026-11-15 | v0.1 — File created; master spec v1.0 captured; initial open questions listed. |
| 2026-11-15 | v0.2 — Added §7A environment strategy (laptop → cloud) and D-004. |
| 2026-11-15 | v0.3 — D-004 accepted; D-005 (Docker confirmed) added; §7B tech stack plan and D-006 (Proposed). |
| 2026-11-15 | v0.4 — Added §7C simplification & robustness plan and D-007 (Proposed). |
| 2026-11-15 | v0.5 — Added §7D minimal-stack option (Vercel + Supabase + Delta) and D-008 (Proposed). |
| 2026-11-15 | v0.6 — Added §1A Final Blueprint and D-009; D-006/007/008 marked superseded. |
| 2026-11-15 | v0.7 — Added §1B MVP definition and D-010 (Proposed). |
| 2026-11-15 | v0.8 — D-011: MVP local-only, no auth, live orders + ETH/SOL in MVP; §1A/§1B updated. |
| 2026-11-15 | v0.9 — §1C Docker-only runtime and Delta India specifics; D-012. |
| 2026-11-15 | v1.0 — §1D VPS plan for fixed IP; D-013 (live on VPS only). |
| 2026-11-15 | v1.1 — Created `MVP_BUILD_PROMPTS.md` (final architecture + ordered agent prompts 1–9). |
| 2026-11-15 | v1.2 — D-014 configurable timeframes (5m–4h); MVP_BUILD_PROMPTS.md §2.10 and prompts 2, 3, 5, 6 updated. |
| 2026-11-15 | v1.3 — D-015 VPS included in MVP: Contabo India (Mumbai), entry 4 vCPU/8 GB plan; MVP_BUILD_PROMPTS.md §5.0 and Prompt 8 updated. |
