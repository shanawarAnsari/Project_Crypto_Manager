# System Overview

Sunny Crypto Manager is a risk-first trading system for **Delta Exchange India** perpetuals. Two deployables (`engine`, `web`) share one PostgreSQL database; the engine is the only component that talks to the exchange and Telegram.

```
Laptop / VPS (Docker Compose)
 web (Next.js, 127.0.0.1:3000) ──reads / writes commands──► postgres ◄──── engine (Node 24, TypeScript)
                                                                              ├─► Delta India (REST + WS)
 migrate (one-shot)      backup (pg_dump → ./backups)                         └─► Telegram
```

## Runtime flow (target, built across Prompts 1–5)

candle closed → strategy-runner → signal → risk-gate (`risk-core` evaluate → `RiskApproval`) → execution (order + exchange-side stop) → fills → portfolio → notifications. Every step carries one correlation ID into `audit_logs`.

## Key properties

- **Paper by default**; live only on the VPS after the paper gate and explicit arming.
- **Fail closed** on stale data, clock drift, unreadable DB, unknown balance.
- **Kill switch** persisted in `engine_state`; UI writes `commands`, engine acks.
- **Money:** INR equity/limits, USD prices; decimals only.
- **Timeframes:** 5m base candles, aggregated to 15m/30m/1h/4h; configured per symbol in `config/strategies.yaml`.
- **Environments:** laptop = dev/backtest/testnet/paper; VPS (Contabo Mumbai, fixed IP) = 24/7 paper soak, later live.
- **Runtime:** Node 24 LTS, PostgreSQL 16, Docker.

See [MASTER_PROJECT_SPECIFICATION.md](./MASTER_PROJECT_SPECIFICATION.md), [service-map.md](./service-map.md), [schema.md](./schema.md).
