# Sunny Crypto Manager frontend

Risk-first Delta Exchange India trading terminal built with React, Vite, strict TypeScript, Tailwind CSS, and lightweight-charts.

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

The Vite dev server proxies `/api` to `http://localhost:4000` by default. Set `API_PROXY_TARGET` to override that backend URL. The production container serves the SPA on port 80 and proxies `/api/` to `http://backend:4000`; the backend must be reachable by the Compose service name `backend`. The nginx config gives `/api/agent/events` a dedicated SSE location with buffering and caching disabled and a long read timeout.

## API contract

All monetary values, quantities, funding rates, and prices in JSON are decimal strings to avoid client-side precision loss. Numeric conversion is only used for chart plotting and display formatting.

- `GET /api/dashboard` returns the `Dashboard` shape in `src/domain/types.ts`. `environment` selects the LIVE (production) or TESTNET badge, independently of account connectivity. `accountEnvironment` reports `live`, `demo`, or `unconfigured`; only `accountStatus: "available"` verifies reconciled account telemetry. `executionConfigured` separately reports credentials plus required trading confirmation; read-only account verification does not require trading confirmation. A testnet backend shows an explicit production-account mismatch warning rather than suggesting live credentials work there.
- `GET /api/candles?tf=1m|5m|15m|30m|1h|4h|1d|1w&limit=500` returns `{ "candles": [{ "time": 1731801600, "open": "..." , "high": "...", "low": "...", "close": "...", "volume": "..." }] }`. `time` is a UTC Unix timestamp in seconds.
- Live charts: after the initial REST load, the dashboard opens a WebSocket to `/api/stream?tf=<selected>` (same origin; nginx and the Vite dev proxy forward the upgrade) and merges each pushed candle in place, so zoom and scroll are preserved. Ticks that arrive while history is loading are buffered. After every reconnect (exponential backoff from 1s up to 15s) the latest 50 candles are re-fetched over REST to fill the gap. The chart header shows `LIVE`, `CONNECTING`, or `STALE`. The chart defaults to `5m`; saving the Agent Chat review timeframe optionally synchronizes the chart after backend confirmation.
- `GET /api/agent` returns the runtime snapshot and persisted `AgentEvent[]` history. The Agent Chat status is refreshed every 5 seconds; an `EventSource` connected to `/api/agent/events` receives `activity` events and uses the browser's resumable `Last-Event-ID`. The UI refreshes the snapshot after SSE reconnects to catch up.
- `POST /api/agent/chat` accepts `{ "message": string }` (up to 2000 characters) and returns `202 { "accepted": true }`. An accepted chat message informs future decisions only; it cannot start automation or place an order. The UI displays only persisted/API-confirmed events, not optimistic messages.
- `POST /api/agent/settings` accepts `{ "timeframe": "1m" | "5m" | "15m" | "30m" | "1h" }` and returns the updated agent snapshot. Saving a setting pauses automation and invalidates outstanding proposals on the backend; on confirmed success the chart follows the selected timeframe.
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
