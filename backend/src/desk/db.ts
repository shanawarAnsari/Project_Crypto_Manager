/** SQLite persistence: decisions journal, trades, Delta order idempotency, execution log, reviews, settings. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { ExecLogRow } from "./delta-bridge.js";
import type { AgentResult, ExecutionVenue } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, instrument TEXT, signal_id TEXT,
  outcome TEXT NOT NULL, summary TEXT, trace TEXT
);
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY, signal_id TEXT, instrument TEXT, direction TEXT, venue TEXT, volume REAL,
  entry REAL, exit REAL, pnl REAL, opened_at REAL, closed_at REAL, reason TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  signal_id TEXT PRIMARY KEY, ts REAL NOT NULL, status TEXT NOT NULL, order_id TEXT, message TEXT, price REAL, request TEXT
);
CREATE TABLE IF NOT EXISTS exec_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, kind TEXT, symbol TEXT, status TEXT,
  order_id TEXT, price REAL, contracts REAL, message TEXT
);
CREATE TABLE IF NOT EXISTS reviews (day TEXT PRIMARY KEY, ts REAL NOT NULL, text TEXT);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`;

export interface DecisionRow {
  id: number;
  ts: number;
  instrument: string;
  signal_id: string | null;
  outcome: string;
  summary: string;
  trace: AgentResult[];
}

export interface TradeRow {
  id: string;
  signal_id: string;
  instrument: string;
  direction: string;
  venue: string;
  volume: number;
  entry: number;
  exit: number | null;
  pnl: number;
  opened_at: number;
  closed_at: number | null;
  reason: string | null;
}

export class DeskDatabase {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.transaction(() => {
      // Older versions mixed simulations, live and testnet rows, with no reliable provenance.
      // Preserve ALL of them, including old settings, unmanaged positions and review text.
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='desk_demo_v2'").get()) {
        for (const table of ["decisions", "trades", "orders", "exec_log", "reviews", "kv"]) {
          if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
            this.db.exec(`ALTER TABLE ${table} RENAME TO legacy_unverified_${table}`);
          }
        }
        this.db.exec("CREATE TABLE desk_demo_v2 (version INTEGER PRIMARY KEY); INSERT INTO desk_demo_v2 VALUES (2)");
      }
      this.db.exec(SCHEMA);
    }).immediate();
  }

  close(): void {
    this.db.close();
  }

  logDecision(instrument: string, signalId: string | null, outcome: string, summary: string, trace: AgentResult[]): number {
    const r = this.db.prepare("INSERT INTO decisions (ts, instrument, signal_id, outcome, summary, trace) VALUES (?,?,?,?,?,?)")
      .run(Date.now() / 1000, instrument, signalId, outcome, summary, JSON.stringify(trace));
    return Number(r.lastInsertRowid);
  }

  decisions(limit = 200, outcome?: string): DecisionRow[] {
    const rows = (outcome
      ? this.db.prepare("SELECT * FROM decisions WHERE outcome=? ORDER BY id DESC LIMIT ?").all(outcome, limit)
      : this.db.prepare("SELECT * FROM decisions ORDER BY id DESC LIMIT ?").all(limit)) as Array<Omit<DecisionRow, "trace"> & { trace: string }>;
    return rows.map((r) => ({ ...r, trace: JSON.parse(r.trace || "[]") as AgentResult[] }));
  }

  decisionsSince(ts: number): DecisionRow[] {
    const rows = this.db.prepare("SELECT * FROM decisions WHERE ts>=? ORDER BY id").all(ts) as Array<Omit<DecisionRow, "trace"> & { trace: string }>;
    return rows.map((r) => ({ ...r, trace: JSON.parse(r.trace || "[]") as AgentResult[] }));
  }

  trades(limit = 500, venue?: ExecutionVenue): TradeRow[] {
    const query = venue
      ? this.db.prepare("SELECT * FROM trades WHERE venue=? ORDER BY closed_at DESC LIMIT ?")
      : this.db.prepare("SELECT * FROM trades ORDER BY closed_at DESC LIMIT ?");
    return (venue ? query.all(venue, limit) : query.all(limit)) as TradeRow[];
  }

  tradesSince(ts: number): TradeRow[] {
    return this.db.prepare("SELECT * FROM trades WHERE closed_at>=?").all(ts) as TradeRow[];
  }

  /** Atomically reserve a signal for exchange execution. False if it was already claimed. */
  claimSignal(signalId: string, request: Record<string, unknown>): boolean {
    const r = this.db.prepare(`INSERT OR IGNORE INTO orders (signal_id, ts, status, request)
      SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM orders WHERE status IN ('pending','unknown'))`)
      .run(signalId, Date.now() / 1000, "pending", JSON.stringify(request));
    return r.changes === 1;
  }

  hasUnresolvedOrder(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM orders WHERE status IN ('pending','unknown') LIMIT 1").get());
  }

  finishSignal(signalId: string, status: string, message: string, orderId: string | null, price: number | null): void {
    this.db.prepare("UPDATE orders SET status=?, message=?, order_id=?, price=? WHERE signal_id=?").run(status, message, orderId, price, signalId);
  }

  logExec(row: ExecLogRow): void {
    this.db.prepare("INSERT INTO exec_log (ts, kind, symbol, status, order_id, price, contracts, message) VALUES (?,?,?,?,?,?,?,?)")
      .run(row.ts, row.kind, row.symbol, row.status, row.order_id, row.price, row.contracts, row.message);
  }

  execLog(limit = 100): ExecLogRow[] {
    return this.db.prepare("SELECT ts, kind, symbol, status, order_id, price, contracts, message FROM exec_log ORDER BY id DESC LIMIT ?").all(limit) as ExecLogRow[];
  }

  saveReview(day: string, text: string): void {
    this.db.prepare("INSERT OR REPLACE INTO reviews VALUES (?,?,?)").run(day, Date.now() / 1000, text);
  }

  reviews(limit = 30): Array<{ day: string; ts: number; text: string }> {
    return this.db.prepare("SELECT * FROM reviews ORDER BY day DESC LIMIT ?").all(limit) as Array<{ day: string; ts: number; text: string }>;
  }

  kvGet<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : fallback;
  }

  kvSet(key: string, value: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO kv VALUES (?,?)").run(key, JSON.stringify(value));
  }
}
