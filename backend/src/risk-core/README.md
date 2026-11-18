# Risk core

Latest Demo revision supersedes older percentages below: <=100% USD equity margin including fee
reserve, <=100x bounded by configured/saved/product leverage, planned loss including round-trip
fees <=30% total USD equity and remaining daily budget, five UTC entries, 50% daily cap bounded
by MAX_DAILY_LOSS. Quantity is floored to whole contracts within all budgets. Lower limits/default
2x remain; production and legacy deterministic risk remain at 2x.

The Demo chat agent uses `approveAgentEntry`, independently of the legacy strategy sizing below.
It enforces at most 100% of USD wallet equity as margin including an entry-fee reserve, available-margin
limits, requested leverage 1..100 (respecting lower configured/operator/product caps), whole contract sizes, <=5 UTC entry
attempts, positive tick-aligned stops/targets, and a planned loss including tax-inclusive round-trip
taker fees <=30% of total USD equity. Targets must cover estimated fees. Remaining daily budget
further limits quantity. Demo daily risk is 50% of start-of-day USD capital bounded by MAX_DAILY_LOSS;
realized ledger fees are already included and unrealized PnL is counted once.
`approveAgentClose` issues expiring one-use approvals for exact-size reduce-only owned exits.
Planned risk is not a guaranteed realized-loss ceiling.

The explicit Demo execution test uses the same approval path with a validated `maxContracts: 1`
quantity cap. This only reduces size; it never rounds an unaffordable order up to one contract or
relaxes the allocation, fee, leverage, entry-count or daily-loss checks.

Explicit manual app-owned Demo exits use `approveAgentClose` with `manual-owned-close` intent.
This intent permits exact-size reduce-only exits while paused/locked, never entries or external
position adoption. Automatic exits still require enabled/unlocked state. Approvals remain frozen,
one-use, expiring and product-scoped. Verified success preserves controls; failures lock the agent.

Risk core is the only issuer of runtime-validated `RiskApproval` objects. Each approval includes a decimal-safe take-profit derived from the configured risk/reward ratio (default 2:1) and the approved entry/stop distance. It fails closed when the bot is disabled, the kill switch is active, inputs are invalid, stops or targets are unsafe, leverage exceeds the configured maximum (hard-capped at 2), or UTC-day realized plus caller-provided unrealized PnL reaches the configured absolute loss limit. Lower leverage remains valid; 2x is a ceiling, not a mandatory order setting. For Demo, the caller supplies reconciled account-wide realized PnL from the wallet ledger and unrealized PnL from all current exchange positions, in the same wallet unit as the loss cap. Quantity is sized from remaining loss budget and leverage-capped notional using decimal arithmetic. Approvals are one-use and expire after 30 seconds. Missing or stale exchange risk inputs lock execution.
