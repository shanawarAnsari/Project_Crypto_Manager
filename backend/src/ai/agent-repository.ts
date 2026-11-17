import type Database from "better-sqlite3";
import type { AgentEvent, AgentTimeframe, AgentTrade } from "./agent-types.js";

export class AgentRepository {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), timeframe TEXT NOT NULL DEFAULT '5m',
        last_candle TEXT, last_review_at INTEGER, revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO agent_settings(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL,
        message TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_trades (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS agent_one_active_trade ON agent_trades((1))
        WHERE json_extract(payload,'$.status') != 'closed';
    `);
  }
  settings(): { timeframe: AgentTimeframe; lastCandle: string | null; lastReviewAt: number | null; revision: number } {
    return this.db.prepare(`SELECT timeframe, last_candle AS lastCandle,
      last_review_at AS lastReviewAt, revision FROM agent_settings WHERE id=1`).get() as ReturnType<AgentRepository["settings"]>;
  }
  setTimeframe(timeframe: AgentTimeframe): void {
    this.db.prepare("UPDATE agent_settings SET timeframe=?, last_candle=NULL, revision=revision+1 WHERE id=1").run(timeframe);
  }
  invalidate(): void {
    this.db.prepare("UPDATE agent_settings SET revision=revision+1 WHERE id=1").run();
  }
  markReview(candle: string, now: number): boolean {
    return this.db.prepare(`UPDATE agent_settings SET last_candle=?, last_review_at=?
      WHERE id=1 AND last_candle IS NOT ?`).run(candle, now, candle).changes === 1;
  }
  event(role: AgentEvent["role"], message: string): AgentEvent {
    const createdAt = Date.now();
    const result = this.db.prepare("INSERT INTO agent_events(role,message,created_at) VALUES(?,?,?)").run(role, message, createdAt);
    return { id: Number(result.lastInsertRowid), role, message, createdAt };
  }
  events(after?: number): AgentEvent[] {
    if (after !== undefined) return this.db.prepare(`SELECT id,role,message,created_at AS createdAt
      FROM agent_events WHERE id>? ORDER BY id LIMIT 200`).all(after) as AgentEvent[];
    return (this.db.prepare(`SELECT id,role,message,created_at AS createdAt
      FROM agent_events ORDER BY id DESC LIMIT 100`).all() as AgentEvent[]).reverse();
  }
  conversation(): AgentEvent[] {
    return (this.db.prepare(`SELECT id,role,message,created_at AS createdAt FROM agent_events
      WHERE role IN ('user','assistant') ORDER BY id DESC LIMIT 30`).all() as AgentEvent[]).reverse();
  }
  saveTrade(trade: AgentTrade): void {
    this.db.prepare(`INSERT INTO agent_trades(id,payload,created_at) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(trade.id, JSON.stringify(trade), trade.createdAt);
  }
  activeTrade(): AgentTrade | null {
    const row = this.db.prepare(`SELECT payload FROM agent_trades
      WHERE json_extract(payload,'$.status') != 'closed' ORDER BY created_at DESC LIMIT 1`).get() as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as AgentTrade : null;
  }
  entryCount(now: number): number {
    const date = new Date(now);
    date.setUTCHours(0, 0, 0, 0);
    return (this.db.prepare("SELECT COUNT(*) AS count FROM agent_trades WHERE created_at>=?").get(date.getTime()) as { count: number }).count;
  }
}
