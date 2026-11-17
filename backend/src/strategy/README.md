# Strategy module

The strategy module implements deterministic `meanReversion`, `trendBreakout`, `gridScalper`, and `flat` signals using `technicalindicators`. Mean reversion requires RSI and Bollinger Band confirmation. Trend breakout requires EMA alignment across 1h/4h/1d/1w, directional ADX confirmation, and an ATR-derived stop bounded by the operator's configured maximum. It produces only a proposed side, reference price, confidence, and protective stop. It never submits orders or changes risk configuration. All trade sizing and price arithmetic are decimal-based.
