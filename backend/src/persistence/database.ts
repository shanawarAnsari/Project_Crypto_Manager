import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CHART_TIMEFRAMES, MAX_LEVERAGE, DEMO_MAX_LEVERAGE } from "../domain.js";

const CANDLE_TIMEFRAME_CHECK = CHART_TIMEFRAMES.map((timeframe) => `'${timeframe}'`).join(", ");
const CANDLES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS candles (
      symbol TEXT NOT NULL DEFAULT 'BTCUSD',
      timeframe TEXT NOT NULL CHECK (timeframe IN (${CANDLE_TIMEFRAME_CHECK})),
      timestamp INTEGER NOT NULL,
      open TEXT NOT NULL,
      high TEXT NOT NULL,
      low TEXT NOT NULL,
      close TEXT NOT NULL,
      volume TEXT NOT NULL,
      PRIMARY KEY (symbol, timeframe, timestamp)
    )`;

export function createDatabase(path: string, leverageCap = MAX_LEVERAGE): Database.Database {
  if (!Number.isFinite(leverageCap) || leverageCap <= 0 || leverageCap > DEMO_MAX_LEVERAGE) {
    throw new Error("Invalid database leverage ceiling");
  }
  const filename = path === ":memory:" ? path : resolve(path);
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 0,
      kill_switch INTEGER NOT NULL DEFAULT 0,
      strategy TEXT NOT NULL DEFAULT 'flat'
        CHECK (strategy IN ('meanReversion', 'trendBreakout', 'gridScalper', 'flat')),
      max_leverage REAL NOT NULL DEFAULT ${MAX_LEVERAGE},
      max_daily_loss TEXT NOT NULL DEFAULT '1000',
      risk_per_trade TEXT NOT NULL DEFAULT '0.5',
      stop_loss_percent TEXT NOT NULL DEFAULT '1',
      risk_reward_ratio TEXT NOT NULL DEFAULT '2',
      strategy_instruction TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO bot_state (id, updated_at) VALUES (1, unixepoch() * 1000);
    ${CANDLES_TABLE_SQL};
    CREATE TABLE IF NOT EXISTS trade_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      product_id INTEGER NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      status TEXT NOT NULL,
      quantity TEXT NOT NULL,
      price TEXT NOT NULL,
      stop_price TEXT,
      take_profit_price TEXT,
      leverage TEXT NOT NULL DEFAULT '1',
      pnl TEXT,
      client_order_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      exit_price TEXT,
      closed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS ai_decision_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      decision TEXT NOT NULL,
      accepted INTEGER NOT NULL,
      rejection_reason TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS service_status (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO service_status (key, value, updated_at) VALUES ('market_websocket', 'disconnected', unixepoch() * 1000);
    CREATE INDEX IF NOT EXISTS idx_trade_logs_created_at ON trade_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_audit_created_at ON ai_decision_audit(created_at DESC);
  `);
  const candleColumns = new Set((db.pragma("table_info(candles)") as Array<{ name: string }>).map((column) => column.name));
  const candleSchema = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'candles'")
    .get() as { sql: string } | undefined)?.sql ?? "";
  if (!candleColumns.has("symbol") || !candleSchema.includes(CANDLE_TIMEFRAME_CHECK)) {
    const symbolSource = candleColumns.has("symbol") ? "symbol" : "'BTCUSD'";
    db.transaction(() => {
      db.exec(`
        DROP INDEX IF EXISTS idx_candles_timeframe_timestamp;
        ALTER TABLE candles RENAME TO candles_legacy;
        ${CANDLES_TABLE_SQL};
        INSERT INTO candles (symbol, timeframe, timestamp, open, high, low, close, volume)
          SELECT ${symbolSource}, timeframe, timestamp, open, high, low, close, volume FROM candles_legacy;
        DROP TABLE candles_legacy;
      `);
    })();
  }
  const tradeColumns = new Set((db.pragma("table_info(trade_logs)") as Array<{ name: string }>).map((column) => column.name));
  if (!tradeColumns.has("leverage")) db.exec("ALTER TABLE trade_logs ADD COLUMN leverage TEXT NOT NULL DEFAULT '1'");
  if (!tradeColumns.has("exit_price")) db.exec("ALTER TABLE trade_logs ADD COLUMN exit_price TEXT");
  if (!tradeColumns.has("closed_at")) db.exec("ALTER TABLE trade_logs ADD COLUMN closed_at INTEGER");
  if (!tradeColumns.has("take_profit_price")) db.exec("ALTER TABLE trade_logs ADD COLUMN take_profit_price TEXT");
  const botColumns = new Set((db.pragma("table_info(bot_state)") as Array<{ name: string }>).map((column) => column.name));
  const migrations: Array<[string, string]> = [
    ["max_leverage", `REAL NOT NULL DEFAULT ${MAX_LEVERAGE}`],
    ["max_daily_loss", "TEXT NOT NULL DEFAULT '1000'"],
    ["risk_per_trade", "TEXT NOT NULL DEFAULT '0.5'"],
    ["stop_loss_percent", "TEXT NOT NULL DEFAULT '1'"],
    ["risk_reward_ratio", "TEXT NOT NULL DEFAULT '2'"],
    ["strategy_instruction", "TEXT NOT NULL DEFAULT ''"]
  ];
  for (const [name, definition] of migrations) {
    if (!botColumns.has(name)) db.exec(`ALTER TABLE bot_state ADD COLUMN ${name} ${definition}`);
  }
  const currentBotColumns = new Set((db.pragma("table_info(bot_state)") as Array<{ name: string }>).map((column) => column.name));
  if (currentBotColumns.has("mode")) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE bot_state_v2 (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled INTEGER NOT NULL DEFAULT 0,
          kill_switch INTEGER NOT NULL DEFAULT 0,
          strategy TEXT NOT NULL DEFAULT 'flat'
            CHECK (strategy IN ('meanReversion', 'trendBreakout', 'gridScalper', 'flat')),
          max_leverage REAL NOT NULL DEFAULT ${MAX_LEVERAGE},
          max_daily_loss TEXT NOT NULL DEFAULT '1000',
          risk_per_trade TEXT NOT NULL DEFAULT '0.5',
          stop_loss_percent TEXT NOT NULL DEFAULT '1',
          risk_reward_ratio TEXT NOT NULL DEFAULT '2',
          strategy_instruction TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL
        );
        INSERT INTO bot_state_v2
          (id, enabled, kill_switch, strategy, max_leverage, max_daily_loss, risk_per_trade,
           stop_loss_percent, risk_reward_ratio, strategy_instruction, updated_at)
        SELECT id, 0, kill_switch, strategy, max_leverage, max_daily_loss, risk_per_trade,
          stop_loss_percent, risk_reward_ratio, strategy_instruction, updated_at FROM bot_state;
        DROP TABLE bot_state;
        ALTER TABLE bot_state_v2 RENAME TO bot_state;
      `);
    })();
  }
  db.prepare(`UPDATE bot_state SET max_leverage = ?, enabled = 0, updated_at = unixepoch() * 1000
    WHERE max_leverage > ?`).run(leverageCap, leverageCap);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_candles_timeframe_timestamp
    ON candles(symbol, timeframe, timestamp DESC)`);
  return db;
}

export function closeDatabase(db: Database.Database): void {
  db.close();
}
