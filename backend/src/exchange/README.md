# Delta Exchange India adapter

The Demo chat agent reads verified `taker_commission_rate` from the configured live/operational
BTCUSD product and applies the published India 18% GST multiplier. Missing or unsupported rates fail
closed. `GET /v2/orders/client_order_id/{id}` reconciles exact client identity, whole-contract fill
and unfilled sizes, average fill, paid commission and bracket protection before owned-trade management.
Candle responses are normalized into chronological order before closed-candle selection.
Actual fees already enter the daily USD wallet ledger and must not be deducted a second time.

The adapter pins REST, order, and market websocket requests to the configured environment: production uses `https://api.india.delta.exchange` and `wss://socket.india.delta.exchange`; Demo/testnet (default) uses `https://cdn-ind.testnet.deltaex.org` and `wss://socket-ind.testnet.deltaex.org`. Delta Global hosts cannot be selected. The UI labels the environment **LIVE** or **Demo**. Current BTCUSD product defaults are production ID `27` and Demo ID `84`; `DELTA_PRODUCT_ID` may explicitly override the selection. Before order placement, the adapter requests `GET /v2/products/BTCUSD` and rejects an ID, symbol, state, or trading status that does not match the configured live, operational BTCUSD product.

REST calls use the Delta API's HMAC-SHA256 signature input: uppercase HTTP method + seconds timestamp + exact request path and query + exact JSON request body. Authenticated requests send `api-key`, `timestamp`, and `signature`; query strings are included in both the HTTP request and signature. Public market requests are `GET /v2/products/{symbol}`, `GET /v2/tickers/{symbol}`, and `GET /v2/history/candles` with `resolution`, `symbol`, and Unix-second `start`/`end` values. Historical candle rows must all validate; malformed rows fail the request instead of being silently dropped.

Account telemetry reads `GET /v2/wallet/balances`, `GET /v2/positions/margined`, and `GET /v2/orders`. Active orders use the documented plural query filters `product_ids` and `states=open,pending`; open-order and wallet-transaction cursors are followed until `meta.after` is explicitly null. Missing metadata, invalid/repeated cursors, and unsupported wallet transaction types fail closed. Daily realized PnL is summed from the selected account's USD wallet transaction ledger using current UTC-day bounds in epoch microseconds; unrealized PnL comes from all current positions in the wallet's native unit.

Entry execution sets leverage with `POST /v2/products/{product_id}/orders/leverage`, then submits `POST /v2/orders` with a market order, deterministic `client_order_id`, and exchange-side stop-loss/take-profit bracket fields. Approved base quantity is converted to whole contracts with `contract_value`; bracket prices are snapped to `tick_size`. These calls are confined to execution and require a consumed matching `RiskApproval`.

The emergency action also stays product-scoped. It cancels all order classes with `DELETE /v2/orders/all` and explicit limit/stop/reduce-only cancellation filters. It closes the configured product's current positions using market `POST /v2/orders` requests with `reduce_only=true` and deterministic client IDs. The documented `POST /v2/positions/close_all` operation is account-wide and requires user identity; it is deliberately not used for a product-scoped approval. Emergency actions require a consumed one-use emergency approval, and success is reported only after authenticated order/position read-back confirms no remaining exposure. Read-back failures are reported as unconfirmed.

The market stream subscribes to `v2/ticker` and supported `candlestick_<timeframe>` channels, validates ticker and candle payloads, and uses ping/pong heartbeat and bounded exponential reconnect.

## Display-only wallet portfolio

`getPortfolioValuation()` reads all wallet balances and sums Delta's own `balance_inr` valuations for every nonzero holding using decimal arithmetic. USD equivalents use the adapter's display USD/INR rate. Never substitute derivative ticker prices: these can differ substantially from exchange wallet valuations. Invalid balances, duplicate assets, missing USD wallet, or missing/invalid INR valuations reject the entire portfolio; never present a partial total as complete. Nonzero valuations must have the same sign as their balances. Zero-balance assets need no valuation. Totals exclude position unrealized PnL; USD equivalents are indicative and values can change between refreshes.

This method is for the dashboard only. `getAccountRiskSnapshot()`, its USD wallet balance, available margin, ledger reconciliation, position PnL, and risk calculations are unchanged. Non-USD holdings must not increase trading collateral or risk caps.
