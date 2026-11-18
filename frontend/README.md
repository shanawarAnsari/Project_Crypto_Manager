# Sunny Crypto Manager frontend

The default UI (`src/pilot/`) is a trading desk for Delta Exchange India with an overview, Chart, Signals, Backtest,
Journal and Settings views, a command palette (Ctrl K), an onboarding tour, a live BTC/ETH mark ticker, account
positions and fills, an execution log, and a hold-to-confirm kill switch. The compact terminal desk (`src/desk/`) is
available at `/?classic`. Both read the same backend snapshot and `/api/ws` stream. The previous chat UI remains in `src/ui/`.

The classic desk shows a KPI strip, a live 5M chart with mapped liquidity pools and the entry/SL/TP ladder,
"Why this trade?", the seven-agent pipeline, positions, the signal feed, the live agent feed, and tabs for Delta
India status/execution log, Backtest Lab, Journal and Settings.

Built with React, Vite, strict TypeScript, Tailwind CSS, lightweight-charts, three.js / react-three-fiber,
framer-motion and zustand.

The default desk uses Delta India market data. The chart names the selected Demo/Live environment and
marks quotes stale after 15 seconds without updates. The primary account strip and positions come from
authenticated exchange reads even when execution is Paper; missing credentials never show a simulated
starting balance as account money. Synthetic data is explicitly opt-in (`DESK_DEMO_MODE=true`).
Account telemetry is separate from locally simulated trades, journals and backtest performance.

## Run and verify

Requires Node.js 24 and pnpm.

```powershell
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Frontend lint uses the TypeScript ESLint recommended rules with zero warnings allowed. Root `pnpm lint` discovers this workspace's `lint` script through Turborepo and checks both frontend and backend.

The Vite dev server proxies `/api` (including the `/api/ws` WebSocket) to `http://127.0.0.1:4000` by default. Set `API_PROXY_TARGET` to override that backend URL. The production container serves the SPA on port 80 and proxies `/api/` to `http://backend:4000`; the backend must be reachable by the Compose service name `backend`. The nginx config gives `/api/agent/events` a dedicated SSE location with buffering and caching disabled and a long read timeout.

## Legacy chat app API contract (`pnpm dev:legacy`)

Latest Demo policy (2026-11-18) supersedes older figures below: margin <=100% verified USD equity
including entry fees; leverage <=100x bounded by lower configured/saved and exchange caps; planned
stop plus fees <=30% total USD equity (not 50% of margin); five UTC attempts; 50% daily loss bounded
by MAX_DAILY_LOSS. Lower caps/default 2x are preserved, not automatically raised. Live is unchanged.
Test leverage selects whole values 1..100/default 1. Initial 1%/2% brackets may narrow to fit equity/
daily budgets; inspect exact preview prices before confirming. Leverage can liquidate before stops.

All monetary values, quantities, funding rates, and prices in JSON are decimal strings to avoid client-side precision loss. Numeric conversion is only used for chart plotting and display formatting.

- `GET /api/dashboard` returns the `Dashboard` shape in `src/domain/types.ts`. `environment` selects the LIVE (production) or TESTNET badge, independently of account connectivity. `accountEnvironment` reports `live`, `demo`, or `unconfigured`; only `accountStatus: "available"` verifies reconciled account telemetry. `executionConfigured` separately reports credentials plus required trading confirmation; read-only account verification does not require trading confirmation. A testnet backend shows an explicit production-account mismatch warning rather than suggesting live credentials work there.
- `GET /api/candles?tf=1m|5m|15m|30m|1h|4h|1d|1w&limit=500` returns `{ "candles": [{ "time": 1731801600, "open": "..." , "high": "...", "low": "...", "close": "...", "volume": "..." }] }`. `time` is a UTC Unix timestamp in seconds.
- Live charts: after the initial REST load, the dashboard opens a WebSocket to `/api/stream?tf=<selected>` (same origin; nginx and the Vite dev proxy forward the upgrade) and merges each pushed candle in place, so zoom and scroll are preserved. Ticks that arrive while history is loading are buffered. After every reconnect (exponential backoff from 1s up to 15s) the latest 50 candles are re-fetched over REST to fill the gap. The chart header shows `LIVE`, `CONNECTING`, or `STALE`. The chart defaults to `5m`; saving the Agent Chat review timeframe optionally synchronizes the chart after backend confirmation.
- `GET /api/agent` returns the runtime snapshot and persisted `AgentEvent[]` history. The Agent Chat status is refreshed every 5 seconds; an `EventSource` connected to `/api/agent/events` receives `activity` events and uses the browser's resumable `Last-Event-ID`. The UI refreshes the snapshot after SSE reconnects to catch up.
- Agent Chat opens history at the newest message and scrolls its conversation viewport to the bottom
  on every message/activity update, including polling/reconnect history. New updates follow the latest
  even after manually scrolling up. The history scrollbar remains available; dashboard scroll and
  input focus are unchanged.
- `POST /api/agent/chat` accepts `{ "message": string }` (up to 2000 characters) and returns `202 { "accepted": true }`. An accepted chat message informs future decisions only; it cannot start automation or place an order. The UI displays only persisted/API-confirmed events, not optimistic messages.
- `POST /api/agent/settings` accepts `{ "timeframe": "1m" | "5m" | "15m" | "30m" | "1h" }` and returns the updated agent snapshot. Saving a setting pauses automation and invalidates outstanding proposals on the backend; on confirmed success the chart follows the selected timeframe.
- **Demo execution test** is a separate signal-free control. Select BUY/SELL and whole leverage 1..100
  (default 1x), request a preview (no order), inspect one BTCUSD contract with stop/target, then explicitly confirm within 30 seconds
  or cancel. It calls `/api/agent/test-entry/preview` and `/api/agent/test-entry/confirm`; the latter
  supplies the one-use token and `PLACE_DEMO_TEST_ORDER`. Running/unlocked Demo automation, verified
  telemetry, no exposure/orders and all normal risk checks are required. No LLM is called for the
  test. No automatic retry or automatic close; System activity distinguishes acknowledgement from fill.
  Selection is locked while previewing/confirming; cancel the preview to change leverage. The preview
  request includes numeric `leverage`; backend confirmation preserves it and enforces configured caps.
- The Demo execution test panel provides **Close app-owned Demo BTCUSD trades** with separate
  confirmation. Only app-owned scheduled/test trades close using risk-approved reduce-only exits;
  external/manual trades and orders and other products are untouched. It calls `/api/agent/close-all`
  with `CLOSE_OWNED_DEMO_BTCUSD` and refreshes dashboard/agent on success/error. Verified success
  preserves controls: running automation continues on its normal schedule and may trade again.
  Paused/locked automation is never enabled/unlocked. No owned trade is a no-op; uncertain ownership,
  exit/read-back or residual orders fail closed, pause and lock without retry. Available while
  paused/locked or without an LLM, never for Live. No blanket order cancellation.
- Demo scheduled entries and one-contract test entries share a 100% maximum USD-equity margin
  allocation including the entry-fee reserve (owner amendment, superseding 25%). Available margin
  and remaining daily budget still bound size. Lower model allocations are valid; test entries
  default to 1x and require explicit confirmation. Lower caps and all stop/fee and daily budgets apply.
- Confirmed open positions show ENTRY, STOP and TARGET price lines on the chart, plus per-position
  exchange-reported running unrealized PnL in USD. The positions table includes both stop and target.
  Account/PnL telemetry is polled every five seconds; failed/unavailable telemetry hides position
  overlays and PnL, not stale values as current. This PnL is not a claim of net realized profit.
- Open orders expose separate **Purpose**, **Trigger price**, execution **Type**, **Limit** and
  **Status** columns. Exchange `stop_order_type=stop_loss_order` displays **Stop loss**;
  `take_profit_order` displays **Take profit / target**. Pending conditional orders display
  **Awaiting trigger** with **Exchange: pending**, not an unfilled-entry claim. The dashboard API
  carries nullable `stopOrderType` and decimal-string `triggerPrice` from exchange `stop_price`.
  Unknown conditional types are labeled unclassified with their raw type; missing triggers show
  Unavailable, never Market. Ordinary orders are not guessed to be entries/protective exits.
  Account failure hides stale order rows. This is display-only and never cancels/changes an order.
- The Agent Chat displays configured model and runtime review status, explicit provider/connection failures, and the Demo-only policy summary. The snapshot's `configured` flag means an API key is present; it does not prove that the provider/model is reachable or usable, so request errors remain visible. The interface displays concise rationales and observable steps, never private reasoning. Production-account starts are disabled in the UI; stopping and kill-switch controls remain available.
- Conversation labels distinguish **LLM response** from **System activity**. New model responses include the
  validated action, summary and every proposed entry field. System messages show the supplied context,
  independent risk outcome, submission acknowledgement and exchange read-back; they are not extra LLM
  calls. Historical messages are preserved as originally recorded. Rejected raw model content is never shown.
- `POST /api/bot/toggle` accepts `{ "enabled": boolean }` and returns `{ "enabled": boolean }` confirming the resulting state.
- `POST /api/kill-switch` returns `{ "accepted": boolean }`.

Account values are shown only after account reconciliation succeeds; unavailable, partial, or failed dashboard responses never display unverified balances. No operator-provided balance is substituted for exchange telemetry. The account banner distinguishes verified/unverified connectivity from paused/enabled/blocked automation. Start is disabled without verified telemetry, execution configuration, or while the risk lock is active. Stop remains available when automation is enabled even if telemetry becomes unavailable. API failures are surfaced to the operator; mutations only update displayed state after API confirmation and a telemetry refresh. Each eligible order still requires fresh reconciliation and risk approval; the bot starts paused after restart. Updating keys alone does not select production, authorize trading, or verify connectivity.

## Module structure

The account cards distinguish **Wallet portfolio (indicative)** from **USD trading wallet** and **Available USD margin**. The Wallet Holdings panel and successful live-account verification sentence are intentionally omitted; account failures, automation state, and portfolio errors remain visible. The portfolio sums nonzero wallets' `balance_inr` values and excludes position unrealized PnL; USD equivalents use the displayed conversion rate, not derivative ticker prices. If portfolio valuation fails, show its explicit error without hiding verified USD trading funds or substituting a USD-only partial total. Non-USD holdings are display-only and do not increase trading collateral or risk limits. The **Leverage cap** card shows the system maximum of 2×, not actual position leverage (which remains in the positions table).

All eight account KPIs are arranged in a single horizontal row. Labels and values use compact type and values may wrap within their card rather than being clipped; on narrower viewports, the row can be scrolled horizontally so every KPI remains available without stacking into additional rows.

The Trading overview emphasizes the indicative wallet portfolio and displays USD amounts separately from secondary INR equivalents. Environment/account context and automation readiness have distinct informational, paused, enabled, and blocked visual states; these styles do not change verification, telemetry, or execution gating.

- `src/api`: typed HTTP boundary and API error handling.
- `src/domain`: transport/domain interfaces used by the UI.
- `src/ui`: account dashboard, Agent Chat, tables, chart, and display formatting.
- `src/test`: shared test setup and UI behavior tests.
