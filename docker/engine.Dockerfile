# syntax=docker/dockerfile:1.7
# Targets: dev | migrate | runtime   (build context = repo root)

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@12.21.0
WORKDIR /app

# ---- deps: install with only manifests so the layer caches ----------------------------------
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/exchange-sdk/package.json packages/exchange-sdk/
COPY packages/trading-core/package.json packages/trading-core/
COPY packages/risk-core/package.json packages/risk-core/
COPY apps/engine/package.json apps/engine/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# ---- dev: hot reload via `docker compose watch` -----------------------------------------------
FROM deps AS dev
COPY . .
RUN pnpm --filter @sunny/db generate
ENV NODE_ENV=development
CMD ["pnpm", "--filter", "@sunny/engine", "dev"]

# ---- build ----------------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @sunny/db generate \
 && pnpm --filter @sunny/engine build \
 && pnpm --filter @sunny/engine deploy --prod --legacy /deploy/engine \
 && pnpm --filter @sunny/db deploy --prod --legacy /deploy/db \
 && cd /deploy/engine \
 && pnpm exec prisma generate --schema node_modules/@sunny/db/prisma/schema.prisma \
 && cp -r /app/apps/engine/dist /deploy/engine/dist

# ---- migrate: one-shot `prisma migrate deploy` ---------------------------------------------------
FROM base AS migrate
ENV NODE_ENV=production
COPY --from=build --chown=node:node /deploy/db /app
USER node
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ---- runtime: the trading engine (no published ports) ---------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /deploy/engine /app
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
