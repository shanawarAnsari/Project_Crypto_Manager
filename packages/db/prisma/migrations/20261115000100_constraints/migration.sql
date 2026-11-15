-- engine_state is a singleton: exactly one row, id = 1
ALTER TABLE "engine_state" ADD CONSTRAINT "engine_state_singleton_chk" CHECK ("id" = 1);

-- Quantities and prices must be positive
ALTER TABLE "orders" ADD CONSTRAINT "orders_qty_positive_chk" CHECK ("qty" > 0);
ALTER TABLE "fills" ADD CONSTRAINT "fills_qty_positive_chk" CHECK ("qty" > 0);
ALTER TABLE "fills" ADD CONSTRAINT "fills_price_positive_chk" CHECK ("price" > 0);
ALTER TABLE "positions" ADD CONSTRAINT "positions_qty_positive_chk" CHECK ("qty" > 0);
ALTER TABLE "symbols" ADD CONSTRAINT "symbols_steps_positive_chk" CHECK ("tick_size" > 0 AND "lot_size" > 0 AND "contract_value" > 0);

-- Candle sanity: high/low bound open/close
ALTER TABLE "candles" ADD CONSTRAINT "candles_ohlc_chk" CHECK ("high" >= "low" AND "high" >= "open" AND "high" >= "close" AND "low" <= "open" AND "low" <= "close");

-- Only a single open position per symbol (one active position per symbol in the MVP)
CREATE UNIQUE INDEX "positions_one_open_per_symbol_idx" ON "positions" ("product_id") WHERE "status" = 'OPEN';

-- Instance lock requires an expiry
ALTER TABLE "engine_state" ADD CONSTRAINT "engine_state_lock_expiry_chk" CHECK ("instance_id" IS NULL OR "instance_lock_expires_at" IS NOT NULL);
