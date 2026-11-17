# AI Context

Sunny Crypto Manager is a greenfield, risk-first BTC strategy dashboard for Delta Exchange India. The source of truth is `docs/MASTER_PROJECT_SPECIFICATION.md` and the agreed implementation scope in `MVP_BUILD_PROMPTS.md`.

## Non-negotiable invariants

- Use Delta Exchange India endpoints only, never Delta Global.
- Only the backend execution boundary may submit exchange orders, and only with a `RiskApproval`.
- Fail closed when risk inputs, market data, or model output are invalid or unavailable.
- Never expose or log API credentials/signatures.
- Use decimal-safe calculations for money and quantity.
- AI output can update strategy configuration only within persisted operator risk caps; it is never a `RiskApproval`.
- NVIDIA NIM uses the OpenAI-compatible endpoint, defaults to `nvidia/nemotron-3.5-bolt-e4b`, and accepts API credentials only from environment variables; model output is strict-JSON validated before application.
- Preserve the daily-loss lock until an explicit manual reset.
- Connect only to the fixed Delta India endpoints selected by `DELTA_ENV` (`production` = real money, `testnet` = Demo, default `testnet`); no other host (never Delta Global) is configurable. Owner decision 2026-11-17: live production trading from the laptop is permitted, BTCUSD only, 2x max leverage, daily loss cap 2% of start-of-day capital. Production orders require `LIVE_TRADING_CONFIRMED=I_UNDERSTAND_REAL_MONEY`. After explicit operator enablement, automated execution is allowed for deterministic strategy signals configured by AI. Do not require per-trade confirmation, but never bypass fresh risk checks or substitute zero/local-only PnL.
- Select credentials by environment: `testnet` uses `DELTA_DEMO_API_KEY` / `DELTA_DEMO_API_SECRET`; `production` uses `DELTA_LIVE_API_KEY` / `DELTA_LIVE_API_SECRET`. Never reuse one environment's keys against the other environment. The legacy `DELTA_API_KEY` / `DELTA_API_SECRET` pair is accepted only when no environment-specific credential values are configured. `DELTA_ENV` changes require backend recreation; startup pauses automation.
- Display the selected environment as **LIVE** or **TESTNET**, separately from account verification. A testnet backend must explicitly warn that production is not selected; never relabel it LIVE. Account reconciliation requires credentials only, not live-trading confirmation. Dashboard `executionConfigured` reports trading configuration separately from `accountStatus`; configuration alone must never imply connection success. Hide unverified balances and disable Start when telemetry is unavailable, the dashboard refresh fails, trading configuration is incomplete, or a risk lock is active; keep Stop available for an enabled bot. Environment-specific BTCUSD product defaults are 27 (production) and 84 (Demo); resolve by symbol and verify configured product ID, live state, and operational status before order submission. Realized PnL comes from the current UTC day's USD wallet transaction ledger using documented epoch-microsecond bounds and complete cursor pagination; unrealized PnL comes from all current positions. Keep the result in the exchange wallet's native unit and compare only against a same-unit risk cap.
- Strategy signal previews are advisory only. Each automated order must refresh ledger/position data and obtain a fresh `RiskApproval`; missing, malformed, incomplete, or unsupported exchange data fails closed, with no local trade-history PnL fallback. Every entry order must use an idempotent client order ID and exchange-side stop protection and must be submitted only through the execution boundary. Order size is converted to whole contracts via `contract_value`; bracket prices are snapped to `tick_size`.
- The bot must start paused after every process restart and require explicit operator re-enablement. Once enabled, eligible risk-approved trades submit automatically without per-trade confirmation.

## Architecture

The `backend` workspace owns Express API routes and supervises the worker lifecycle, with isolated database, exchange, strategy, risk, AI, and execution modules. The `frontend` workspace is a typed React/Vite client and calls only the backend API. Both workspaces are independently buildable and testable and are orchestrated from the repository root with pnpm, Turborepo, and Docker Compose.

## API surfaces

The dashboard uses `/api/health`, `/api/dashboard`, `/api/signal/preview`, `/api/candles?tf=1m|5m|15m|30m|1h|4h|1d|1w` (intraday timeframes are chart-only and kept live via the selected Delta India environment's `candlestick_<tf>` websocket; the worker relays candles over IPC and the API pushes them to the UI on the output-only WebSocket `/api/stream?tf=`), `/api/strategy`, `/api/bot/toggle`, and `/api/kill-switch`. There is no per-trade confirmation endpoint. Keep response types explicit and report unavailable services rather than returning success-shaped fabricated values. Exchange emergency actions are allowed only against the configured Delta India environment, through the execution module with a one-use risk approval. Use product-scoped order cancellation and reduce-only position closes; confirm success with authenticated read-back. Never call the account-wide close-all-positions endpoint for a product-scoped approval.

Telemetry is available only after current-day wallet-ledger realized PnL has reconciled. The bot-toggle endpoint explicitly enables or pauses automation; the worker starts paused after restart and never silently resumes persisted enabled state. Automated execution evaluates only fresh closed hourly candles and independently refreshes exchange PnL before obtaining a fresh approval for each order. Missing credentials, missing live confirmation, or missing telemetry disables execution; no estimated-account fallback is allowed.

## Current decisions

Owner-approved replacement (2026-11-17): implemented a Demo-only NVIDIA chat agent, default
closed 5m reviews with a combined 1m/5m/15m/30m/1h selector, persistent chat/trade state and live
activity summaries (not private chain-of-thought). AI may propose entries/hold/owned exits instead
of choosing deterministic strategies. Chat cannot enable execution. Preserve explicit Start,
restart-paused behavior, independent risk approvals, exchange brackets and emergency controls.
Risk: <=25% USD equity as margin (also available-margin bounded), <=2x leverage, planned stop
loss plus tax-inclusive round-trip taker fees <=5% of allocated margin, <=5 UTC entry attempts,
Demo daily loss cap 10% (owner explicitly superseded the earlier 2% selection), absolute
MAX_DAILY_LOSS still applies. Never manage externally opened positions. Implementation and
verification status must be recorded before claiming deployment or a successful trade.

The API server now owns TradingAgent; worker.ts is market-data-only. Production Start is rejected.
New API: GET /api/agent, POST /api/agent/chat, POST /api/agent/settings, GET /api/agent/events (SSE with
persisted IDs/replay). Legacy strategy mutation and force-AI routes return 410 when runtime is attached.
The model receives closed OHLCV, account/owned-trade context, tax-inclusive taker rate and the most
recent 30 conversation messages. Exact trade identity/thesis persists independently. Actions are
strict wait/hold/open/close proposals. Live activity is observable steps and concise summaries.
Agent Chat stage-visibility follow-up: new assistant messages show the full validated action and
summary, plus side, margin percentage, leverage, stop and target for OPEN. UI labels them LLM response;
context-ready, independent risk outcomes, submission acknowledgements and read-back confirmations
are System activity. One model call per chat/review, not one per deterministic stage; no private
reasoning or rejected provider output. Old events keep their original text. Focused verification:
19 backend lifecycle/API tests and 22 dashboard tests pass; workspace lint/typecheck/build pass.
Built and deployed both Compose images; after the owner restarted Docker, backend health and new
frontend bundle were verified. Browser confirms LLM response/System activity labels and connected SSE;
running backend includes full-decision/context/submission updates. No extra model request or trade was
triggered for this follow-up. Owner had re-enabled Demo automation after restart; observed no active
agent trade, and that owner-selected enabled state was left unchanged during final read-only checks.
Changing timeframe pauses and invalidates pending proposals; Start/Stop/kill controls are revisioned
to prevent stale in-flight decisions or readiness requests from re-enabling or submitting orders.

The USD wallet excludes unrealized PnL. Start-of-day capital is derived as wallet balance minus
realized ledger PnL; the breaker compares realized plus unrealized PnL once. Demo uses 10% even if
legacy DAILY_LOSS_PERCENT remains 2; MAX_DAILY_LOSS still bounds it. Product taker fees plus 18% India
GST are estimated for both order legs. Actual charges already enter ledger PnL; do not subtract twice.
Exchange gaps/slippage/funding can exceed planned loss. Partial/uncertain fills, missing protection,
residual orders or ownership mismatches fail closed and need operator reconciliation.

Deployment check: rebuilt/recreated the owner's existing Docker Compose stack (Node 24 images), not a
second host process against the live bind-mounted SQLite file. Do not run Windows SQLite writers
concurrently with Docker's Linux SQLite against the same bind mount. Pre-agent stopped-database backup
is in session files. A real NVIDIA chat request succeeded and its response appeared in the live SSE UI.
Account telemetry verified available in TESTNET; no exchange order was submitted during setup.
An operator Start was observed during UI verification; only HOLD was recorded, no agent trade existed,
and automation was explicitly paused again before continuing deployment verification.
Earlier emergency-readback test failure was fixed by binding gateway verification callbacks; the
candle test now correctly asserts chronological first/latest timestamps. All existing backend tests pass.

Final verification for this replacement: workspace lint/typecheck/build pass; 123 backend tests and
28 frontend tests pass. Backend line coverage 90.33%, risk-core 97.15%, execution 96.24%.
Docker images build on Node 24; host tests ran on installed Node 25.6.1 and emit the known engine warning.
Read-only Demo product verification returned a tax-inclusive taker rate of 0.00059; the live NVIDIA
connectivity message succeeded. Browser verified Agent Chat, default 5m, connected activity stream,
visible provider reply and no AI Control Deck. Order entry/full exit was verified with mocked exchange
lifecycle tests, not by opening a real Demo position; the next owner test is an explicitly enabled
Demo trade. No successful trade or profitability claim is made.

Owner UI/leverage update 2026-11-17: keep Wallet portfolio (indicative) and USD trading wallet cards; remove the Wallet Holdings panel and successful live-account verification sentence. Preserve account/portfolio error messages and automation controls. Leverage is capped at 2x system-wide, with lower limits allowed (not exactly 2x for all orders). Configuration rejects higher values; database initialization defaults to 2x and reduces legacy higher limits with automation paused. API, AI, risk, execution, and gateway enforce the ceiling. The dashboard leverage card shows the configured cap; the positions table retains actual exchange leverage. No exchange position or credentials are changed.

Dashboard account KPI presentation: all eight KPI cards stay in one horizontal row, with compact text, wrapping values instead of truncating them, and horizontal scrolling on narrow screens.

The Trading overview visually emphasizes the indicative portfolio total and separates USD primary amounts from INR equivalents. Environment/account context and automation state use distinct informational, paused, enabled, or blocked treatments. These are presentation-only changes: preserve all telemetry gating, existing error messages, and the rule that environment selection does not verify an account.

The strategy editor offers Mean reversion, Trend breakout, Grid scalping, and Flat (no entries) in a dropdown. Selection is a draft until the operator uses Apply strategy.

Verification for the UI/leverage update: all 26 frontend tests, workspace lint, typecheck, and build passed. The broader backend/API run passed 39 tests and retained the same two known emergency-readback and candle-timestamp failures; leverage policy tests cover configuration, risk, AI caps, persisted-limit migration, and execution after a lowered cap. These changes have not been deployed to running services and do not resolve the previously reported safety-test failures.

Owner balance-display decision 2026-11-17: show total wallet portfolio value plus a separate USD trading wallet balance and exact nonzero holdings. The previous “Account equity” card displayed only the USD wallet and omitted BTC holdings. Dashboard `portfolio` is a display-only valuation (`totalUsd`, `totalInr`, `holdings`) or null with `portfolioError`. Sum Delta's own `balance_inr` values; derive indicative USD equivalents using the adapter's display rate. Derivative ticker prices were verified to differ from wallet valuations and must not be substituted. Reject incomplete valuations; never substitute a USD-only partial total. Portfolio totals exclude position unrealized PnL and must never increase trading collateral or risk caps. `account.equity` and risk/account reconciliation remain USD-wallet based.

Portfolio verification: 12 portfolio adapter tests, 3 ledger tests, 5 targeted backend account/execution-gate tests, and all 25 frontend tests passed; workspace lint, typecheck, and build passed. Read-only verification of the built adapter against the running backend's wallet response confirmed separate USD and BTC holdings and summed exchange INR valuations. Amounts fluctuate; do not hardcode the owner's reported total. No services were restarted, credentials changed, or orders placed; the observed bot remained off. The prior two broader backend failures and Node 25 versus required Node 24 warning remain outside this balance-display change.

The repository is a fresh implementation; deleted historical files are not assumed to exist. The supplied build prompt defines product functionality, subject to the safety invariants above. Owner decision 2026-11-17 supersedes the earlier Demo-only rule: live production execution from the laptop is permitted (static IP, 24x7), BTCUSD only, after explicit bot enablement and per-order risk approval.

Account-status UI verification (2026-11-17): frontend suite 23/23 passed; targeted backend account/configuration tests 5/5 passed; workspace build, lint, and typecheck passed. The broader backend test file had 38 passing tests and two failures in unchanged emergency-action read-back and candle-timestamp expectations; these remain unresolved and are not a clean backend safety sign-off. The available Node runtime was 25.6.1 rather than the required 24 LTS. The owner declined production read-only environment configuration during this task; credentials, environment settings, and bot state were not changed, no running services were restarted, and no real exchange orders or balance verification were attempted.
