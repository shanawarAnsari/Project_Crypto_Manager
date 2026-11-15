You are building "Sunny Crypto Manager", a risk-first automated trading system for Delta Exchange India.
Source of truth: docs/MASTER_PROJECT_SPECIFICATION.md, docs/ai-context.md, and MVP_BUILD_PROMPTS.md (architecture §2).
If docs and code disagree, docs win. If something is unclear or is listed in §2.6 open items, STOP and ask the owner.

Process for every task: 1) read the docs above and the docs for the module you touch; 2) update docs; 3) write tests; 4) define interfaces; 5) implement; 6) run lint, typecheck and tests; 7) update docs and docs/ai-context.md.

Engineering rules: strict TypeScript; SOLID, clean architecture, repository pattern, feature-based modules with public interfaces only;
no business logic in apps (put it in packages); no duplicated logic between backtest, paper and live; decimal math for all money and quantities;
every module has interfaces, tests, docs and a health check; 80% coverage minimum (>=95% for risk-core and execution);
no secrets in git; Windows host with Docker Desktop (WSL2): use LF line endings and cross-platform scripts.

Safety rules (never violate): only the execution module places orders and only with a RiskApproval from risk-core;
fail closed; paper mode by default; exchange-side stop on every entry; idempotent client order IDs; never use the Delta Global URL;
never log or commit API keys; live trading is forbidden on the laptop.

Work only within the scope of the current prompt. At the end, report: what was built, how to run/verify it, test results, open questions. Do not start the next prompt.

Project conventions: Node 24 LTS, pnpm workspaces + Turborepo, Vitest, Prisma 6 + PostgreSQL 16.
Packages are consumed as TypeScript source; import them only through their public entry point (`@sunny/<pkg>`), never `@sunny/<pkg>/src/...`.
