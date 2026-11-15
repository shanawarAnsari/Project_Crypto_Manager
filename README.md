# Sunny Crypto Manager

Risk-first automated trading system for **Delta Exchange India** (paper by default). Status: **MVP, Stage 1 — foundation** (engine is idle; no trading logic yet).

Docs: [docs/MASTER_PROJECT_SPECIFICATION.md](docs/MASTER_PROJECT_SPECIFICATION.md) · build plan: [MVP_BUILD_PROMPTS.md](MVP_BUILD_PROMPTS.md).

## Requirements

- Node **24.x** (`.nvmrc`), pnpm 12 (`packageManager` field), Docker Desktop (WSL2)
- Windows: keep LF line endings (`.gitattributes` enforces it)

## Quick start (Docker)

```powershell
Copy-Item .env.example .env.testnet      # then edit the password; never commit .env.*
docker compose up -d --build
docker compose ps                         # postgres, engine, web, backup healthy; migrate exited 0
```

Open <http://127.0.0.1:3000> — the dashboard shows the live engine heartbeat. Everything is bound to `127.0.0.1`; there is no login, so never expose it to a network.

Verify:

```powershell
docker compose run --rm backup once       # writes a dump into ./backups
docker compose run --rm engine node dist/main.js   # 2nd engine -> refused by the instance lock
docker compose down                       # add -v to also delete the database volume
```

## Local development

```powershell
pnpm install
pnpm db:generate
pnpm lint; pnpm typecheck; pnpm test      # also: pnpm build, pnpm format
pnpm compose:dev                          # hot reload in Docker (docker compose watch)
```

If a corporate proxy re-signs TLS (Prisma/npm download errors such as "self-signed certificate"), set `NODE_OPTIONS=--use-system-ca` for the shell.

| Script                                          | Purpose                            |
| ----------------------------------------------- | ---------------------------------- |
| `pnpm dev / build / test / lint / typecheck`    | Turborepo tasks                    |
| `pnpm db:migrate`                               | `prisma migrate deploy`            |
| `pnpm compose:up / compose:down / compose:logs` | Docker Compose helpers             |
| `pnpm backup:now`                               | One-off `pg_dump` into `./backups` |

## Layout

```
apps/engine   long-running worker (modules: health, heartbeat, ...)
apps/web      Next.js dashboard (reads Postgres only)
packages/     core · db · exchange-sdk · trading-core · risk-core
docker/       Dockerfiles, backup script
docs/         documentation (docs win over code)
```

Safety rules: only `execution` places orders and only with a `RiskApproval`; fail closed; paper by default; live trading is forbidden on the laptop.
