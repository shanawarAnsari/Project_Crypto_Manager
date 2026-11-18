FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/

FROM base AS build
RUN apk add --no-cache python3 make g++
RUN pnpm install --frozen-lockfile --filter @sunny/backend
COPY backend/tsconfig.json backend/
COPY backend/src backend/src
RUN pnpm --filter @sunny/backend build
RUN pnpm install --frozen-lockfile --prod --filter @sunny/backend

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist
WORKDIR /app/backend
RUN mkdir -p /app/data
EXPOSE 4000
CMD ["node", "dist/src/desk-server.js"]