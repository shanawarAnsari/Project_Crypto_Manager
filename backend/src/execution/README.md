# Execution

Latest Demo revision allows <=100x but execution independently enforces lower configuration/saved
limits and the verified product cap (100 / initial_margin). Gateway leverage-setting acknowledgement
is required before entry. Production/legacy retain the 2x ceiling; existing positions are not modified.

The Demo-panel manual close uses the owned-exit path, never `emergencyHalt` or blanket cancellation.
Only authenticated app-owned BTCUSD trades may close; external/manual exposure is excluded.
A fresh `manual-owned-close` risk intent permits reduce-only exits while paused/locked, without
enabling entries. Signed size/product checks still apply. Verified success preserves automation
controls/scheduling; uncertain ownership/fill/residual orders pause and lock at the agent boundary.
The emergency kill-switch cancellation/close behavior below is unchanged.

The Demo chat agent also has `closeAgentPosition`: a separate fresh, one-use risk approval is required.
The gateway rechecks the exact signed position size and submits an idempotent reduce-only market order.
The agent performs authenticated client-order and account read-back; unknown/partial exits are not
reported as closed. Entry submission rechecks current enabled/kill-switch state after asynchronous
product resolution and leverage configuration. The legacy deterministic worker no longer submits orders.
Emergency read-back callbacks are bound to their gateway instance so verification actually executes.

All entry order submission is confined to `ExecutionService` and its Delta India gateway (`DeltaIndiaOrderGateway`). Every entry requires explicit bot enablement, a fresh one-use `RiskApproval`, a deterministic client order ID, and mandatory exchange-side stop-loss and take-profit bracket fields (`bracket_stop_loss_price`, `bracket_take_profit_price`, `bracket_stop_trigger_method=mark_price`). The gateway applies approved leverage, resolves the configured product through the BTCUSD symbol endpoint and checks that it is live and operational, converts the approved base quantity to whole contracts (`floor(quantity / contract_value)`), and snaps bracket prices to `tick_size` toward entry. Production execution also requires `LIVE_TRADING_CONFIRMED`.

Emergency cancellation/close requests require a separate one-use risk approval after the local kill switch is latched. Cancellation explicitly includes limit, stop, and reduce-only order classes. Position closes use reduce-only market orders scoped to the approved product, rather than Delta's account-wide close-all endpoint. The execution service reads active orders and positions back from the exchange; it returns success only when the requested product has no remaining exposure. A failed read-back is unconfirmed, not successful.

Entry leverage cannot exceed the minimum of the current persisted limit, environment configuration,
verified exchange product limit and environment ceiling (100x Demo, 2x Live). The gateway independently
enforces product/environment caps. Lower leverage remains allowed; no migration raises saved caps
or changes existing exchange positions.
