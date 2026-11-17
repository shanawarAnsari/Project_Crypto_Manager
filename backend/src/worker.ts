import { DeltaMarketStream, type StreamCandle } from "./exchange/market-stream.js";
import { CHART_TIMEFRAMES } from "./domain.js";
import { createServices } from "./services.js";

// This process only supplies market data. The API process owns the single trading-agent loop.
const services = createServices();
const stream = new DeltaMarketStream({ environment: services.config.deltaEnvironment });
let busy = false;
async function refresh(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const results = await Promise.allSettled(CHART_TIMEFRAMES.map(async (timeframe) => {
      const candles = await services.delta.getCandles(timeframe, "BTCUSD", 500);
      services.candles.upsert(timeframe, candles);
    }));
    if (results.some((r) => r.status === "rejected")) {
      services.status.set("worker_status", "market_backfill_partial");
      process.stderr.write("Some market histories could not be refreshed.\n");
    } else services.status.set("worker_status", "running");
    const ticker = await services.delta.getTicker("BTCUSD");
    services.status.set("market_price", ticker.price);
    if (ticker.fundingRate !== null) services.status.set("funding_rate", ticker.fundingRate);
  } catch {
    services.status.set("worker_status", "market_refresh_failed");
    process.stderr.write("Market refresh failed; no order is submitted by this worker.\n");
  } finally { busy = false; }
}
services.status.set("market_websocket", "disconnected");
stream.on("connected", () => services.status.set("market_websocket", "connected"));
stream.on("disconnected", () => services.status.set("market_websocket", "reconnecting"));
stream.on("heartbeat", () => services.status.set("market_websocket", "connected"));
stream.on("streamError", () => services.status.set("market_websocket", "reconnecting"));
stream.on("ticker", (ticker: { markPrice: string; fundingRate: string | null }) => {
  services.status.set("market_price", ticker.markPrice);
  if (ticker.fundingRate !== null) services.status.set("funding_rate", ticker.fundingRate);
});
stream.on("candle", (update: StreamCandle) => {
  try { services.candles.upsert(update.timeframe, [update.candle], update.symbol); }
  catch {
    process.stderr.write("Live candle persistence failed; awaiting REST repair.\n");
    return;
  }
  if (process.connected) process.send?.({ type: "candle", timeframe: update.timeframe, candle: update.candle });
});
stream.connect();
const interval = setInterval(() => { void refresh(); }, 60_000);
void refresh();
function shutdown(): void {
  clearInterval(interval);
  stream.close();
  services.db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
