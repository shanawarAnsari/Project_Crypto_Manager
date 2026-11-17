import type Database from "better-sqlite3";
import Decimal from "decimal.js";
import type { BotState, Candle, ChartTimeframe, StrategyName, Side } from "../domain.js";

export interface BotStateRepository {
  get(): BotState;
  update(patch: Partial<Omit<BotState, "updatedAt">>): BotState;
}

export interface CandleRepository {
  list(timeframe: ChartTimeframe, limit?: number, symbol?: string): Candle[];
  upsert(timeframe: ChartTimeframe, values: readonly Candle[], symbol?: string): void;
  latestPrice(symbol?: string): string | null;
}

export interface TradeRepository {
  record(trade: {
    productId: number; side: Side; status: string; quantity: string;
    price: string; stopPrice: string | null; takeProfitPrice?: string | null; leverage?: string; pnl?: string | null; clientOrderId: string;
  }): number;
  dailyRealizedPnl(now?: number): string;
  allTimeRealizedPnl(): string;
  hasPendingSubmission(productId: number): boolean;
  confirmSubmission(clientOrderId: string): void;
  updateSubmissionStatus(id: number, status: "submitted" | "submission_unknown"): void;
  recent(limit?: number): Array<{
    id: number; side: Side; status: string; quantity: string;
    price: string; pnl: string | null; createdAt: number;
  }>;
}

export interface AiAuditRepository {
  record(entry: { model: string; promptHash: string; decision: string; accepted: boolean; rejectionReason: string | null }): number;
  recent(limit?: number): Array<{ id: number; decision: string; reason: string; accepted: boolean; createdAt: number }>;
}

export interface ServiceStatusRepository {
  get(key: string): string | null;
  getUpdatedAt(key: string): number | null;
  set(key: string, value: string): void;
}

export class SqliteServiceStatusRepository implements ServiceStatusRepository {
  constructor(private readonly db: Database.Database) {}
  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM service_status WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  getUpdatedAt(key: string): number | null {
    const row = this.db.prepare("SELECT updated_at AS updatedAt FROM service_status WHERE key = ?")
      .get(key) as { updatedAt: number } | undefined;
    return row?.updatedAt ?? null;
  }
  set(key: string, value: string): void {
    this.db.prepare(`INSERT INTO service_status (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, value, Date.now());
  }
}

export class SqliteBotStateRepository implements BotStateRepository {
  constructor(private readonly db: Database.Database) {}
  get(): BotState {
    const row = this.db.prepare(`SELECT enabled, kill_switch, strategy, max_leverage, max_daily_loss,
      risk_per_trade, stop_loss_percent, risk_reward_ratio, strategy_instruction, updated_at FROM bot_state WHERE id = 1`)
      .get() as {
        enabled: number; kill_switch: number; strategy: StrategyName;
        max_leverage: number; max_daily_loss: string; risk_per_trade: string; stop_loss_percent: string; risk_reward_ratio: string;
        strategy_instruction: string; updated_at: number;
      };
    return {
      enabled: row.enabled === 1, killSwitch: row.kill_switch === 1,
      strategy: row.strategy, maxLeverage: row.max_leverage, maxDailyLoss: row.max_daily_loss,
      riskPerTrade: row.risk_per_trade, stopLossPercent: row.stop_loss_percent,
      riskRewardRatio: row.risk_reward_ratio,
      instruction: row.strategy_instruction, updatedAt: row.updated_at
    };
  }
  update(patch: Partial<Omit<BotState, "updatedAt">>): BotState {
    const current = this.get();
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.db.prepare(`UPDATE bot_state SET enabled = ?, kill_switch = ?, strategy = ?,
      max_leverage = ?, max_daily_loss = ?, risk_per_trade = ?, stop_loss_percent = ?,
      risk_reward_ratio = ?, strategy_instruction = ?, updated_at = ? WHERE id = 1`)
      .run(Number(next.enabled), Number(next.killSwitch), next.strategy, next.maxLeverage,
        next.maxDailyLoss, next.riskPerTrade, next.stopLossPercent, next.riskRewardRatio, next.instruction, next.updatedAt);
    return next;
  }
}

export class SqliteCandleRepository implements CandleRepository {
  constructor(private readonly db: Database.Database) {}
  list(timeframe: ChartTimeframe, limit = 500, symbol = "BTCUSD"): Candle[] {
    const rows = this.db.prepare(`SELECT timestamp, open, high, low, close, volume FROM candles
      WHERE symbol = ? AND timeframe = ? ORDER BY timestamp DESC LIMIT ?`)
      .all(symbol, timeframe, Math.min(Math.max(limit, 1), 1000)) as Candle[];
    return rows.reverse();
  }
  upsert(timeframe: ChartTimeframe, values: readonly Candle[], symbol = "BTCUSD"): void {
    const insert = this.db.prepare(`INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(symbol, timeframe, timestamp) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume`);
    const transaction = this.db.transaction((candles: readonly Candle[]) => {
      for (const candle of candles) insert.run(symbol, timeframe, candle.timestamp, candle.open, candle.high, candle.low, candle.close, candle.volume);
    });
    transaction(values);
  }
  latestPrice(symbol = "BTCUSD"): string | null {
    const row = this.db.prepare("SELECT close FROM candles WHERE symbol = ? ORDER BY timestamp DESC LIMIT 1")
      .get(symbol) as { close: string } | undefined;
    return row?.close ?? null;
  }
}

export class SqliteTradeRepository implements TradeRepository {
  constructor(private readonly db: Database.Database) {}
  confirmSubmission(clientOrderId: string): void {
    this.db.prepare(`UPDATE trade_logs SET status='submitted' WHERE client_order_id=?
      AND status IN ('submitting','submission_unknown')`).run(clientOrderId);
  }
  record(trade: {
    productId: number; side: Side; status: string; quantity: string;
    price: string; stopPrice: string | null; takeProfitPrice?: string | null; leverage?: string; pnl?: string | null; clientOrderId: string;
  }): number {
    const result = this.db.prepare(`INSERT INTO trade_logs
      (mode, product_id, side, status, quantity, price, stop_price, take_profit_price, leverage, pnl, client_order_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "testnet", trade.productId, trade.side, trade.status, trade.quantity, trade.price,
      trade.stopPrice, trade.takeProfitPrice ?? null, trade.leverage ?? "1", trade.pnl ?? null, trade.clientOrderId, Date.now()
    );
    return Number(result.lastInsertRowid);
  }
  dailyRealizedPnl(now = Date.now()): string {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const rows = this.db.prepare("SELECT pnl FROM trade_logs WHERE mode = 'testnet' AND closed_at >= ? AND pnl IS NOT NULL")
      .all(start.getTime()) as Array<{ pnl: string }>;
    return rows.reduce((total, row) => total.plus(row.pnl), new Decimal(0)).toString();
  }
  allTimeRealizedPnl(): string {
    const rows = this.db.prepare("SELECT pnl FROM trade_logs WHERE mode = 'testnet' AND closed_at IS NOT NULL AND pnl IS NOT NULL")
      .all() as Array<{ pnl: string }>;
    return rows.reduce((total, row) => total.plus(row.pnl), new Decimal(0)).toString();
  }
  hasPendingSubmission(productId: number): boolean {
    const row = this.db.prepare(`SELECT 1 FROM trade_logs WHERE mode = 'testnet' AND product_id = ?
      AND status IN ('submitting', 'submission_unknown') LIMIT 1`)
      .get(productId);
    return row !== undefined;
  }
  updateSubmissionStatus(id: number, status: "submitted" | "submission_unknown"): void {
    this.db.prepare(`UPDATE trade_logs SET status = ? WHERE id = ? AND mode = 'testnet' AND status = 'submitting'`)
      .run(status, id);
  }
  recent(limit = 20): Array<{ id: number; side: Side; status: string; quantity: string; price: string; pnl: string | null; createdAt: number }> {
    return this.db.prepare(`SELECT id, side, status, quantity, price, pnl, created_at AS createdAt
      FROM trade_logs WHERE mode = 'testnet'
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 100)) as Array<{
      id: number; side: Side; status: string; quantity: string; price: string; pnl: string | null; createdAt: number;
    }>;
  }
}

export class SqliteAiAuditRepository implements AiAuditRepository {
  constructor(private readonly db: Database.Database) {}
  record(entry: { model: string; promptHash: string; decision: string; accepted: boolean; rejectionReason: string | null }): number {
    const result = this.db.prepare(`INSERT INTO ai_decision_audit
      (model, prompt_hash, decision, accepted, rejection_reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(entry.model, entry.promptHash, entry.decision, Number(entry.accepted), entry.rejectionReason, Date.now());
    return Number(result.lastInsertRowid);
  }
  recent(limit = 10): Array<{ id: number; decision: string; reason: string; accepted: boolean; createdAt: number }> {
    const rows = this.db.prepare(`SELECT id, decision, COALESCE(rejection_reason, '') AS reason,
      accepted, created_at AS createdAt FROM ai_decision_audit
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(Math.min(Math.max(limit, 1), 50)) as Array<{
      id: number; decision: string; reason: string; accepted: number; createdAt: number;
    }>;
    return rows.map((row) => ({ ...row, accepted: row.accepted === 1 }));
  }
}
