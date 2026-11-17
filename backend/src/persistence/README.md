# Persistence

`AgentRepository` adds agent settings/revision and closed-candle checkpoints, ordered durable chat/activity
events, and JSON trade records with exact entry/exit client IDs and thesis. Atomic candle claiming and
a unique active-trade index prevent duplicate reviews/reservations. Uncertain entry attempts remain
counted for the UTC daily limit. Authenticated order identity read-back alone may resolve a pending
trade-log submission; a failed network request is never treated as proof of rejection.

SQLite is opened with WAL and foreign-key enforcement. Repositories isolate bot settings, symbol/timeframe candles, trade records, AI audit records, and service status from the HTTP and worker layers. Candle upserts and reads are symbol-scoped; daily and all-time realized PnL aggregation uses `decimal.js` rather than SQLite floating-point sums. Schema initialization applies forward-compatible state and candle-table migrations.

New bot state defaults to a 2x leverage cap. Initialization reduces legacy limits above 2x and pauses automation in the same update. Lower limits, trade history, risk locks, and existing exchange positions are preserved.
