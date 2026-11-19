import Decimal from "decimal.js";
import type { BotState } from "./domain.js";
import { DEMO_DAILY_LOSS_PERCENT, leverageCeiling } from "./domain.js";
import { loadConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import type Database from "better-sqlite3";
import { DeltaIndiaClient } from "./exchange/delta-client.js";
import {
  SqliteAiAuditRepository, SqliteBotStateRepository, SqliteCandleRepository,
  SqliteServiceStatusRepository, SqliteTradeRepository
} from "./persistence/repositories.js";
import { createDatabase } from "./persistence/database.js";
import { RiskCore } from "./risk-core/risk-core.js";
import { ExecutionService } from "./execution/execution-service.js";
import { DeltaIndiaOrderGateway } from "./execution/delta-order-gateway.js";
import { AiDecisionService } from "./ai/decision-service.js";

export interface AppServices {
  config: AppConfig;
  db: Database.Database;
  botState: SqliteBotStateRepository;
  candles: SqliteCandleRepository;
  trades: SqliteTradeRepository;
  aiAudit: SqliteAiAuditRepository;
  status: SqliteServiceStatusRepository;
  delta: DeltaIndiaClient;
  risk: RiskCore;
  execution: ExecutionService;
  ai: AiDecisionService;
}

export function createServices(): AppServices {
  const config = loadConfig();
  if (config.deltaEnvironment !== "testnet") throw new Error("The application is demo-only. Set DELTA_ENV=testnet.");
  const db = createDatabase(config.databasePath, leverageCeiling(config.deltaEnvironment));
  const botState = new SqliteBotStateRepository(db);
  const candles = new SqliteCandleRepository(db);
  const trades = new SqliteTradeRepository(db);
  const aiAudit = new SqliteAiAuditRepository(db);
  const status = new SqliteServiceStatusRepository(db);
  const delta = new DeltaIndiaClient({
    apiKey: config.deltaApiKey,
    apiSecret: config.deltaApiSecret,
    productId: config.deltaProductId,
    environment: config.deltaEnvironment
  });
  const risk = new RiskCore(config.maxDailyLoss, config.maxLeverage, config.deltaEnvironment);
  const orderGateway = new DeltaIndiaOrderGateway({
    apiKey: config.deltaApiKey,
    apiSecret: config.deltaApiSecret,
    productId: config.deltaProductId,
    environment: config.deltaEnvironment
  }, fetch, () => delta.getProductSpec(), () => {
    const state = botState.get();
    return state.enabled && !state.killSwitch;
  });
  const execution = new ExecutionService(trades, orderGateway, config);
  const ai = new AiDecisionService(config.nimApiKey, config.nimBaseUrl, config.aiModel, aiAudit);
  if (botState.get().enabled) botState.update({ enabled: false });
  return { config, db, botState, candles, trades, aiAudit, status, delta, risk, execution, ai };
}

export function testnetExecutionConfigured(services: Pick<AppServices, "config">): boolean {
  const { config } = services;
  if (config.deltaEnvironment === "production" && !config.liveTradingConfirmed) return false;
  return Boolean(config.deltaApiKey && config.deltaApiSecret);
}

export { testnetExecutionConfigured as executionConfigured };

// The USD wallet balance already excludes unrealized PnL; Live keeps its configured policy.
export function syncDailyLossCap(
  services: Pick<AppServices, "config" | "botState">,
  account: { equity: string; realizedPnl: string; unrealizedPnl: string }
): BotState {
  const startCapital = new Decimal(account.equity).minus(account.realizedPnl);
  const cap = Decimal.min(
    startCapital.mul(services.config.deltaEnvironment === "testnet" ? DEMO_DAILY_LOSS_PERCENT : services.config.dailyLossPercent).div(100),
    services.config.maxDailyLoss
  ).toDecimalPlaces(8, Decimal.ROUND_DOWN);
  if (!cap.isFinite()) throw new Error("Daily loss cap could not be derived from account capital");
  // A zero or negative cap is persisted as "0", which risk-core treats as an active breach (fail closed).
  return services.botState.update({ maxDailyLoss: Decimal.max(cap, 0).toString() });
}
