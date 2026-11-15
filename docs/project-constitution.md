# Project Constitution — Sunny Crypto Manager

## Principles

1. **Capital preservation first.** Controlled drawdown, consistent sizing, reliability and observability beat profit.
2. **Documentation wins over code.** Read docs, update docs, write tests, define interfaces, implement, verify, update docs and `ai-context.md`.
3. **Build small, boring, safe;** earn complexity with evidence and exit gates. Work only within the current prompt's scope.
4. **Ask, never guess** on open items (see the master specification §12).
5. **One implementation.** No duplicated logic between backtest, paper and live.
6. **Clean boundaries.** Strict TypeScript (Node 24 LTS), SOLID, repository pattern, feature modules with public interfaces only, no business logic in apps.
7. **Decimal math** for every money value and quantity; never floats.
8. **Quality bar.** Every module has interfaces, tests, docs and a health check. Coverage ≥ 80%; ≥ 95% on `risk-core` and `execution`.
9. **Audit everything.** Signal → risk decision → order → fill share a correlation ID.
10. **No secrets in git or logs.** Cross-platform scripts, LF line endings, Windows host with Docker Desktop (WSL2).

## Safety rules (never violate)

1. Only the `execution` module places orders, and only with a `RiskApproval` created by `risk-core`.
2. Fail closed: if kill-switch state, balance, clock sync, market-data freshness or DB readability cannot be verified, place no orders.
3. Paper mode by default; live requires explicit arming and is refused unless the live env is running on the VPS and the paper gate has passed.
4. Exchange-side stop-loss on every entry; verify a stop exists for every open position.
5. Idempotent, deterministic client order IDs.
6. Never use the Delta Global URL (`api.delta.exchange`); production is Delta India only.
7. Never log or commit API keys. Live keys exist only on the VPS (Trading + Read, IP-whitelisted).
8. Live trading is forbidden on the laptop.
9. Kill switch is persisted, set automatically on any risk breach, and reset only manually via a confirmed command.
10. Exchange is the source of truth; reconcile before trading.
11. Single engine instance per account (instance lock).
12. Dashboard has no login: it must never be reachable from a network (127.0.0.1 / Tailscale / SSH tunnel only). Auth is mandatory before any exposure.
