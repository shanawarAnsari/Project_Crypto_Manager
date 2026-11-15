# Service Map

## Containers

| Service    | Image/Runtime     | Ports                                                       | Depends on        | Notes                                        |
| ---------- | ----------------- | ----------------------------------------------------------- | ----------------- | -------------------------------------------- |
| `postgres` | PostgreSQL 16     | `127.0.0.1:5432`                                            | —                 | named volume, healthcheck                    |
| `migrate`  | Node 24 + Prisma  | none                                                        | postgres healthy  | one-shot `prisma migrate deploy`             |
| `engine`   | Node 24           | none (internal health endpoint for Docker healthcheck only) | migrate completed | `restart: unless-stopped`                    |
| `web`      | Node 24 + Next.js | `127.0.0.1:3000`                                            | migrate completed | reads DB; writes only `commands`             |
| `backup`   | postgres client   | none                                                        | postgres healthy  | scheduled `pg_dump` → `./backups`, retention |

## Engine modules (`apps/engine/src/modules/`)

| Module            | Responsibility                                                                                | Stage / Prompt |
| ----------------- | --------------------------------------------------------------------------------------------- | -------------- |
| `health`          | internal health endpoint, heartbeat to `engine_state`, instance lock                          | 1 / P1         |
| `market-data`     | backfill, gap repair, WS candle stream, 5m→higher aggregation, stale-data guard, clock offset | 2 / P2         |
| `backtest`        | replay candles through same strategy + risk-core, cost model, reports                         | 3 / P3         |
| `risk-gate`       | build state, call `risk-core`, persist decisions, kill switch, fail-closed checks             | 4 / P4         |
| `execution`       | order lifecycle, idempotent client IDs, bracket stops, reconciliation; only order placer      | 4b / P5        |
| `strategy-runner` | load `config/strategies.yaml`, consume `CandleClosed`, create order intents                   | 4b / P5        |
| `portfolio`       | equity, PnL windows, drawdown, exposure, snapshots                                            | 4b / P5        |
| `notifications`   | Telegram alerts (rate-limited, no secrets)                                                    | 4b / P5        |
| `commands`        | process `commands` rows from the UI with ack + audit                                          | 4b / P5        |

## Packages

| Package        | Responsibility                                                                           |
| -------------- | ---------------------------------------------------------------------------------------- |
| `core`         | domain types, Decimal/Money, EventBus (in-memory), typed errors, zod config, pino logger |
| `db`           | Prisma schema, migrations, repositories                                                  |
| `exchange-sdk` | `ExchangeAdapter` + `delta-india`, `delta-testnet`, `paper`, `mock`                      |
| `trading-core` | EMA/ATR/RSI, `Strategy` interface, EMA-trend strategy                                    |
| `risk-core`    | pure risk rules, sizing, `RiskApproval`, kill-switch rules                               |

## Communication

- engine ↔ web: **only via Postgres** (`engine_state`, `commands`, `risk_events`, `positions`, …).
- engine modules: typed in-process `EventBus` (e.g. `CandleClosed`) and public interfaces only.
- engine → exchange: only through `exchange-sdk`; engine → Telegram: `notifications`.
- Only `execution` places orders, only with a `RiskApproval`.
