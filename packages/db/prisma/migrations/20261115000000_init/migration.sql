-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "trading_mode" AS ENUM ('PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "order_side" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "order_type" AS ENUM ('MARKET', 'LIMIT', 'STOP_MARKET', 'STOP_LIMIT');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "position_side" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "position_status" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "command_status" AS ENUM ('PENDING', 'ACKED', 'REJECTED');

-- CreateTable
CREATE TABLE "symbols" (
    "product_id" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "contract_value" DECIMAL(38,18) NOT NULL,
    "tick_size" DECIMAL(38,18) NOT NULL,
    "lot_size" DECIMAL(38,18) NOT NULL,
    "settling_asset" TEXT NOT NULL,
    "enabled_paper" BOOLEAN NOT NULL DEFAULT false,
    "enabled_live" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "symbols_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "candles" (
    "product_id" INTEGER NOT NULL,
    "timeframe" TEXT NOT NULL,
    "open_time" TIMESTAMPTZ(6) NOT NULL,
    "open" DECIMAL(38,18) NOT NULL,
    "high" DECIMAL(38,18) NOT NULL,
    "low" DECIMAL(38,18) NOT NULL,
    "close" DECIMAL(38,18) NOT NULL,
    "volume" DECIMAL(38,18) NOT NULL,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("product_id","timeframe","open_time")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" UUID NOT NULL,
    "correlation_id" UUID NOT NULL,
    "strategy_id" TEXT NOT NULL,
    "product_id" INTEGER NOT NULL,
    "timeframe" TEXT NOT NULL,
    "side" "order_side" NOT NULL,
    "candle_time" TIMESTAMPTZ(6) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "client_order_id" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "product_id" INTEGER NOT NULL,
    "side" "order_side" NOT NULL,
    "type" "order_type" NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'NEW',
    "qty" DECIMAL(38,18) NOT NULL,
    "price" DECIMAL(38,18),
    "stop_price" DECIMAL(38,18),
    "exchange_order_id" TEXT,
    "mode" "trading_mode" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fills" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "exchange_fill_id" TEXT NOT NULL,
    "price" DECIMAL(38,18) NOT NULL,
    "qty" DECIMAL(38,18) NOT NULL,
    "fee" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "fee_asset" TEXT NOT NULL DEFAULT 'INR',
    "filled_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" UUID NOT NULL,
    "product_id" INTEGER NOT NULL,
    "side" "position_side" NOT NULL,
    "qty" DECIMAL(38,18) NOT NULL,
    "entry_price" DECIMAL(38,18) NOT NULL,
    "stop_price" DECIMAL(38,18),
    "status" "position_status" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trades" (
    "id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "correlation_id" UUID NOT NULL,
    "entry_price" DECIMAL(38,18) NOT NULL,
    "exit_price" DECIMAL(38,18),
    "pnl_inr" DECIMAL(38,18),
    "fees_inr" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "strategy_id" TEXT NOT NULL,
    "notes" TEXT,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_events" (
    "id" UUID NOT NULL,
    "correlation_id" UUID,
    "rule" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "correlation_id" UUID,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entity_id" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engine_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "mode" "trading_mode" NOT NULL DEFAULT 'PAPER',
    "trading_enabled" BOOLEAN NOT NULL DEFAULT false,
    "kill_switch" BOOLEAN NOT NULL DEFAULT false,
    "kill_switch_reason" TEXT,
    "heartbeat_at" TIMESTAMPTZ(6),
    "clock_offset_ms" INTEGER,
    "instance_id" TEXT,
    "instance_lock_expires_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engine_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commands" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "command_status" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acked_at" TIMESTAMPTZ(6),
    "result" JSONB,

    CONSTRAINT "commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "symbols_symbol_key" ON "symbols"("symbol");

-- CreateIndex
CREATE INDEX "candles_product_id_timeframe_open_time_idx" ON "candles"("product_id", "timeframe", "open_time" DESC);

-- CreateIndex
CREATE INDEX "signals_correlation_id_idx" ON "signals"("correlation_id");

-- CreateIndex
CREATE INDEX "signals_product_id_created_at_idx" ON "signals"("product_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "orders_client_order_id_key" ON "orders"("client_order_id");

-- CreateIndex
CREATE INDEX "orders_correlation_id_idx" ON "orders"("correlation_id");

-- CreateIndex
CREATE INDEX "orders_product_id_created_at_idx" ON "orders"("product_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "fills_exchange_fill_id_key" ON "fills"("exchange_fill_id");

-- CreateIndex
CREATE INDEX "fills_order_id_idx" ON "fills"("order_id");

-- CreateIndex
CREATE INDEX "fills_filled_at_idx" ON "fills"("filled_at" DESC);

-- CreateIndex
CREATE INDEX "positions_product_id_status_idx" ON "positions"("product_id", "status");

-- CreateIndex
CREATE INDEX "trades_correlation_id_idx" ON "trades"("correlation_id");

-- CreateIndex
CREATE INDEX "trades_opened_at_idx" ON "trades"("opened_at" DESC);

-- CreateIndex
CREATE INDEX "risk_events_created_at_idx" ON "risk_events"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_correlation_id_idx" ON "audit_logs"("correlation_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "commands_status_requested_at_idx" ON "commands"("status", "requested_at");

-- AddForeignKey
ALTER TABLE "candles" ADD CONSTRAINT "candles_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "symbols"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "symbols"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "symbols"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "symbols"("product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
