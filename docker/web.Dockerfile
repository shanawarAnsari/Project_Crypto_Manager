# syntax=docker/dockerfile:1.7
# Targets: dev | runtime   (build context = repo root)

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@12.21.0
WORKDIR /app

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

FROM deps AS dev
COPY . .
RUN pnpm --filter @sunny/db generate
ENV NODE_ENV=development
EXPOSE 3000
CMD ["pnpm", "--filter", "@sunny/web", "dev"]

FROM deps AS build
COPY . .
RUN pnpm --filter @sunny/db generate && pnpm --filter @sunny/web build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/status').then(r=>process.exit(r.status<500||r.status===503?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
