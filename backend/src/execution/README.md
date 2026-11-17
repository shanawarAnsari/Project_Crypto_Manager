# Execution

The Demo chat agent also has `closeAgentPosition`: a separate fresh, one-use risk approval is required.
The gateway rechecks the exact signed position size and submits an idempotent reduce-only market order.
The agent performs authenticated client-order and account read-back; unknown/partial exits are not
reported as closed. Entry submission rechecks current enabled/kill-switch state after asynchronous
product resolution and leverage configuration. The legacy deterministic worker no longer submits orders.
Emergency read-back callbacks are bound to their gateway instance so verification actually executes.

All entry order submission is confined to `ExecutionService` and its Delta India gateway (`DeltaIndiaOrderGateway`). Every entry requires explicit bot enablement, a fresh one-use `RiskApproval`, a deterministic client order ID, and mandatory exchange-side stop-loss and take-profit bracket fields (`bracket_stop_loss_price`, `bracket_take_profit_price`, `bracket_stop_trigger_method=mark_price`). The gateway applies approved leverage, resolves the configured product through the BTCUSD symbol endpoint and checks that it is live and operational, converts the approved base quantity to whole contracts (`floor(quantity / contract_value)`), and snaps bracket prices to `tick_size` toward entry. Production execution also requires `LIVE_TRADING_CONFIRMED`.

Emergency cancellation/close requests require a separate one-use risk approval after the local kill switch is latched. Cancellation explicitly includes limit, stop, and reduce-only order classes. Position closes use reduce-only market orders scoped to the approved product, rather than Delta's account-wide close-all endpoint. The execution service reads active orders and positions back from the exchange; it returns success only when the requested product has no remaining exposure. A failed read-back is unconfirmed, not successful.

Entry leverage cannot exceed the minimum of the current persisted limit, environment configuration, and the 2x system ceiling. The gateway independently rejects leverage above 2x. Lower leverage remains allowed; no startup migration changes existing exchange positions.
