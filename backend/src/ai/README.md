# AI decision advisory

## Explicit Demo execution test

`POST /api/agent/test-entry/preview` accepts `{ "side": "buy" | "sell" }` and performs read-only
checks. It returns a one-use `token`, `expiresAt`, `side`, `contracts`, `entryPrice`, `stopPrice`,
`takeProfitPrice` and `leverage`. No LLM/signal is required. The test proposes one BTCUSD contract
at 1x, with initial 1% stop / 2% target distances (tick-aligned by risk-core).
`POST /api/agent/test-entry/confirm` accepts `{ "token": string, "confirmation": "PLACE_DEMO_TEST_ORDER" }`.
The token expires after 30 seconds, is consumed even on a failed confirmation and is invalid after
restart/control changes. Confirmation refreshes risk inputs and uses normal execution and ownership
reconciliation. Bot Start remains mandatory; Demo credentials, no exposure/orders, all margin/fee/daily
limits and brackets remain mandatory. Preview errors are visible; uncertain submissions/read-back
failures latch the normal risk lock. No retry or automatic test close. Scheduled management continues.

## Demo chat agent (current dashboard)

The dashboard now uses `TradingAgent` / `NvidiaAgentModel`, not the legacy strategy adviser below.
The API process owns one agent; the worker is market-data-only. `AgentRepository` stores conversation,
review checkpoints, trade identity/thesis and resumable activity events in SQLite.
`GET /api/agent` reports status (configured means key presence, not successful provider verification).
`POST /api/agent/chat` accepts a message up to 2000 characters and starts analysis only, never an order.
The most recent 30 user/assistant messages supply bounded conversational context; the active trade
thesis is included independently. Older messages remain in storage but are not all model context.
`POST /api/agent/settings` sets 1m/5m/15m/30m/1h (default 5m), pauses the bot and invalidates pending decisions.
`GET /api/agent/events?after=<id>` streams persisted SSE `activity` events and supports Last-Event-ID replay.
The UI shows observable activity and concise findings, not private internal model reasoning.
Each model response shows its validated action and summary, plus side, margin percentage, leverage,
stop and target for entries. Context-ready, risk-validation, submission-acknowledgement and fill/exit
confirmation events are explicitly system activity, not fabricated model responses. There is one
model call per chat/review; malformed raw provider output is not exposed. Historical events retain
their original text; the additional detail applies to new reviews and messages.

After explicit Start, the agent reviews fresh closed candles once per selected candle. Between reviews,
it reconciles account risk and trade state every five seconds when not processing a model request.
Model proposals are strict action-specific JSON: wait, hold, open or close. Opens include side, stop,
target, leverage and a margin percentage <=25. Chat proposals are restricted to wait.
Provider errors, invalid decisions, stale data and uncertain ownership pause and latch a visible risk lock.
There is no automatic order retry. An uncertain entry remains durable and consumes a daily attempt;
exact client-order read-back can resolve submission status after operator attention.

Only Demo agent execution is allowed. Risk independently enforces <=25% USD equity margin (entry fee
also reserved), <=2x leverage and lower persisted caps, planned stop plus estimated tax-inclusive
round-trip taker fees <=5% actual allocated margin, <=5 entry attempts per UTC day, and the 10% Demo
daily-loss cap bounded by MAX_DAILY_LOSS. Available margin and remaining daily budget further reduce size.
The USD wallet excludes unrealized PnL: start-of-day capital is wallet balance minus realized ledger PnL;
daily breach compares realized plus unrealized PnL once. Ledger commissions/funding are not deducted twice.
The verified BTCUSD product supplies taker fees; the published India 18% GST multiplier is included
([fee schedule](https://www.delta.exchange/fees)). Missing fee data blocks execution.

Every entry goes through RiskCore and ExecutionService with mandatory exchange stop/target brackets.
Owned position size and average entry must match the exact completed entry order before management.
Closes use separate one-use risk approvals and exact-size reduce-only market orders; completion requires
read-back showing no product position or working orders. Partial fills, unexpected position changes,
and residual orders fail closed for manual reconciliation; the agent does not cancel external orders.
Stop/target exits are reconciled on the next monitoring pass. Exchange stops remain active during
provider outages. Planned loss is not guaranteed against gaps, slippage, funding or exchange failures.

Run local development from the repository root with Node 24:
`$env:DATABASE_PATH = 'H:\Project_Crypto_Manager\data\bot.sqlite'; node --env-file=.env --import .\backend\node_modules\tsx\dist\loader.mjs .\backend\src\server.ts`
or use the built server after `pnpm --filter @sunny/backend build`:
`node --env-file=.env .\backend\dist\src\server.js`.
Set NVIDIA_API_KEY (or NVIDIA_NIM_API_KEY) in the ignored root .env, never in chat.
Legacy strategy mutation/reevaluation endpoints return 410 when the agent runtime is attached.

## Legacy adviser (retained for compatibility/tests only)

NVIDIA NIM is called through the OpenAI SDK using the configured NIM base URL. The default model is `nvidia/nemotron-3.5-bolt-e4b`. Set `NVIDIA_API_KEY` (or `NVIDIA_NIM_API_KEY`) in the root `.env`; credentials are never stored in source control. Responses use a non-streaming JSON-object request and require a strict Zod-validated strategy, reasoning, and decimal-string risk parameter set. The model receives the current operator parameters and instruction to suggest no greater risk. Prompt content is hashed rather than persisted; accepted or rejected decisions and model identifiers are stored in the audit repository.

Accepted recommendations may update strategy configuration, but leverage, per-trade risk, stop distance, and risk/reward ratio are each capped at the persisted operator setting (and the hard leverage limit). The worker reevaluates periodically; strategy or instruction updates trigger an immediate evaluation, and `POST /api/ai/decision` forces one on demand. A recommendation is never a `RiskApproval` and does not directly execute an order.

The leverage schema and model prompt allow at most 2x. Parameter application independently caps leverage at 2x even with legacy inputs; lower persisted/operator limits are never raised.
