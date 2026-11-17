import "dotenv/config";
import Decimal from "decimal.js";
import { z } from "zod";
import { MAX_LEVERAGE } from "./domain.js";

const EnvironmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_PATH: z.string().min(1).default("/app/data/bot.sqlite"),
  DELTA_API_KEY: z.string().default(""),
  DELTA_API_SECRET: z.string().default(""),
  DELTA_DEMO_API_KEY: z.string().default(""),
  DELTA_DEMO_API_SECRET: z.string().default(""),
  DELTA_LIVE_API_KEY: z.string().default(""),
  DELTA_LIVE_API_SECRET: z.string().default(""),
  DELTA_PRODUCT_ID: z.preprocess(
    (value) => value === "" || value === undefined ? undefined : value,
    z.coerce.number().int().positive().optional()
  ),
  MAX_LEVERAGE: z.coerce.number().positive().max(MAX_LEVERAGE).default(MAX_LEVERAGE),
  MAX_DAILY_LOSS: z.string().default("1000"),
  DAILY_LOSS_PERCENT: z.string().default("2"),
  DELTA_ENV: z.enum(["production", "testnet"]).default("testnet"),
  LIVE_TRADING_CONFIRMED: z.string().default(""),
  NVIDIA_NIM_API_KEY: z.string().default(""),
  NVIDIA_API_KEY: z.string().default(""),
  NVIDIA_NIM_BASE_URL: z.string().url().default("https://integrate.api.nvidia.com/v1"),
  AI_MODEL: z.string().min(1).default("nvidia/nemotron-3.5-bolt-e4b")
});

export type AppConfig = Readonly<{
  port: number;
  databasePath: string;
  deltaApiKey: string;
  deltaApiSecret: string;
  deltaProductId: number;
  maxLeverage: number;
  maxDailyLoss: string;
  dailyLossPercent: string;
  deltaEnvironment: "production" | "testnet";
  liveTradingConfirmed: boolean;
  nimApiKey: string;
  nimBaseUrl: string;
  aiModel: string;
}>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvironmentSchema.parse(source);
  const hasEnvironmentSpecificCredentials = Boolean(
    parsed.DELTA_DEMO_API_KEY || parsed.DELTA_DEMO_API_SECRET ||
    parsed.DELTA_LIVE_API_KEY || parsed.DELTA_LIVE_API_SECRET
  );
  const selectedCredentials = parsed.DELTA_ENV === "production"
    ? { apiKey: parsed.DELTA_LIVE_API_KEY, apiSecret: parsed.DELTA_LIVE_API_SECRET }
    : { apiKey: parsed.DELTA_DEMO_API_KEY, apiSecret: parsed.DELTA_DEMO_API_SECRET };
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(parsed.MAX_DAILY_LOSS) || new Decimal(parsed.MAX_DAILY_LOSS).lte(0)) {
    throw new Error("MAX_DAILY_LOSS must be a positive decimal amount");
  }
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(parsed.DAILY_LOSS_PERCENT) ||
      new Decimal(parsed.DAILY_LOSS_PERCENT).lte(0) || new Decimal(parsed.DAILY_LOSS_PERCENT).gt(100)) {
    throw new Error("DAILY_LOSS_PERCENT must be a percentage in (0, 100]");
  }
  return Object.freeze({
    port: parsed.PORT,
    databasePath: parsed.DATABASE_PATH,
    deltaApiKey: hasEnvironmentSpecificCredentials ? selectedCredentials.apiKey : parsed.DELTA_API_KEY,
    deltaApiSecret: hasEnvironmentSpecificCredentials ? selectedCredentials.apiSecret : parsed.DELTA_API_SECRET,
    deltaProductId: parsed.DELTA_PRODUCT_ID ?? (parsed.DELTA_ENV === "production" ? 27 : 84),
    maxLeverage: parsed.MAX_LEVERAGE,
    maxDailyLoss: parsed.MAX_DAILY_LOSS,
    dailyLossPercent: parsed.DAILY_LOSS_PERCENT,
    deltaEnvironment: parsed.DELTA_ENV,
    liveTradingConfirmed: parsed.LIVE_TRADING_CONFIRMED === "I_UNDERSTAND_REAL_MONEY",
    nimApiKey: parsed.NVIDIA_NIM_API_KEY || parsed.NVIDIA_API_KEY,
    nimBaseUrl: parsed.NVIDIA_NIM_BASE_URL,
    aiModel: parsed.AI_MODEL
  });
}
