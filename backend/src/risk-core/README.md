# Risk core

The Demo chat agent uses `approveAgentEntry`, independently of the legacy strategy sizing below.
It enforces at most 25% of USD wallet equity as margin including an entry-fee reserve, available-margin
limits, requested leverage 1..2 (respecting lower operator caps), whole contract sizes, <=5 UTC entry
attempts, positive tick-aligned stops/targets, and a planned loss including tax-inclusive round-trip
taker fees <=5% of allocated margin. Targets must cover estimated fees. Remaining daily budget
further limits quantity. Demo daily risk is 10% of start-of-day USD capital bounded by MAX_DAILY_LOSS;
realized ledger fees are already included and unrealized PnL is counted once.
`approveAgentClose` issues expiring one-use approvals for exact-size reduce-only owned exits.
Planned risk is not a guaranteed realized-loss ceiling.

Risk core is the only issuer of runtime-validated `RiskApproval` objects. Each approval includes a decimal-safe take-profit derived from the configured risk/reward ratio (default 2:1) and the approved entry/stop distance. It fails closed when the bot is disabled, the kill switch is active, inputs are invalid, stops or targets are unsafe, leverage exceeds the configured maximum (hard-capped at 2), or UTC-day realized plus caller-provided unrealized PnL reaches the configured absolute loss limit. Lower leverage remains valid; 2x is a ceiling, not a mandatory order setting. For Demo, the caller supplies reconciled account-wide realized PnL from the wallet ledger and unrealized PnL from all current exchange positions, in the same wallet unit as the loss cap. Quantity is sized from remaining loss budget and leverage-capped notional using decimal arithmetic. Approvals are one-use and expire after 30 seconds. Missing or stale exchange risk inputs lock execution.
