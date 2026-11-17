# Backend modules

Current agent flow supersedes the older strategy flow below: `server.ts` owns the durable Demo chat
agent and its five-second monitoring timer; `worker.ts` only supplies REST/WebSocket market data.
The agent reviews closed candles at the selected cadence and routes direct validated proposals through
risk and execution. Legacy strategy mutation endpoints are disabled when the runtime is attached.

`app.ts` defines the HTTP boundary; `services.ts` wires adapters and repositories. `server.ts` supervises the worker lifecycle. The worker connects to the Delta India environment selected by `DELTA_ENV`, refreshes supported candle timeframes, consumes validated websocket tickers, checks reconciled realized-plus-unrealized daily loss, and requests periodic or instruction-triggered AI reviews. AI configures bounded deterministic strategies; after explicit bot enablement, eligible signals are automatically reconciled, approved, and submitted through the execution boundary. `GET /api/signal/preview` is advisory and never authorizes or submits an order. Exchange requests are pinned to Delta India hosts; production Delta Global endpoints are not supported.
