import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

/** Load backend/.env first, then the repository root .env (values already set win). */
export function loadEnvFiles(): void {
  for (const p of [resolve(process.cwd(), "backend", ".env"), resolve(process.cwd(), ".env"), resolve(process.cwd(), "..", ".env")]) {
    if (existsSync(p)) dotenv.config({ path: p, quiet: true });
  }
}

const bool = z.preprocess((v) => (typeof v === "string" ? ["1", "true", "yes", "on"].includes(v.toLowerCase()) : v), z.boolean());

const Schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DESK_DATABASE_PATH: z.string().min(1).default("./data/desk.sqlite"),
  DESK_INSTRUMENTS: z.string().default("BTCUSD,ETHUSD"),
  DESK_DEMO_MODE: bool.default(false),
  DESK_EXECUTION: z.enum(["paper", "delta"]).default("paper"),
  DESK_DEMO_CYCLE_SECONDS: z.coerce.number().min(0.5).max(60).default(3),
  DESK_STARTING_BALANCE: z.coerce.number().positive().default(10_000),
  DESK_MAX_LEVERAGE: z.coerce.number().int().min(1).max(100).default(25),
  DELTA_ENV: z.enum(["production", "testnet"]).default("testnet"),
  DELTA_API_KEY: z.string().default(""),
  DELTA_API_SECRET: z.string().default(""),
  DELTA_DEMO_API_KEY: z.string().default(""),
  DELTA_DEMO_API_SECRET: z.string().default(""),
  DELTA_LIVE_API_KEY: z.string().default(""),
  DELTA_LIVE_API_SECRET: z.string().default(""),
  LIVE_TRADING_CONFIRMED: z.string().default(""),
  DELTA_IP_FAMILY: z.enum(["4", "auto"]).default("4"),
  ANALYST_API_KEY: z.string().default(""),
  ANALYST_BASE_URL: z.string().default(""),
  ANALYST_MODEL: z.string().default(""),
  ANALYST_TIMEOUT_SECONDS: z.coerce.number().min(3).max(120).default(30),
  NVIDIA_NIM_API_KEY: z.string().default(""),
  NVIDIA_API_KEY: z.string().default(""),
  NVIDIA_NIM_BASE_URL: z.string().default("https://integrate.api.nvidia.com/v1"),
  AI_MODEL: z.string().default("nvidia/nemotron-3.5-bolt-e4b")
});

export interface DeskConfig {
  port: number;
  databasePath: string;
  instruments: string[];
  demoMode: boolean;
  execution: "paper" | "delta";
  demoCycleSeconds: number;
  startingBalance: number;
  maxLeverage: number;
  deltaEnvironment: "production" | "testnet";
  deltaApiKey: string;
  deltaApiSecret: string;
  liveTradingConfirmed: boolean;
  /** "4" pins outbound connections to IPv4 so Delta API-key IP whitelists (usually IPv4) match. */
  ipFamily: "4" | "auto";
  analystApiKey: string;
  analystBaseUrl: string;
  analystModel: string;
  analystTimeoutMs: number;
}

export function loadDeskConfig(env: NodeJS.ProcessEnv = process.env): DeskConfig {
  const e = Schema.parse(env);
  const live = e.DELTA_ENV === "production";
  const envKey = live ? e.DELTA_LIVE_API_KEY : e.DELTA_DEMO_API_KEY;
  const envSecret = live ? e.DELTA_LIVE_API_SECRET : e.DELTA_DEMO_API_SECRET;
  const hasScopedCredentials = Boolean(e.DELTA_DEMO_API_KEY || e.DELTA_DEMO_API_SECRET || e.DELTA_LIVE_API_KEY || e.DELTA_LIVE_API_SECRET);
  const deltaApiKey = hasScopedCredentials ? envKey : e.DELTA_API_KEY;
  const deltaApiSecret = hasScopedCredentials ? envSecret : e.DELTA_API_SECRET;
  if (e.DESK_EXECUTION === "delta" && e.DELTA_ENV !== "testnet") {
    throw new Error("DESK_EXECUTION=delta is restricted to DELTA_ENV=testnet; use the explicit live unlock for production.");
  }
  if (e.DESK_EXECUTION === "delta" && e.DESK_DEMO_MODE) {
    throw new Error("DESK_EXECUTION=delta requires Delta market data; synthetic DESK_DEMO_MODE is incompatible.");
  }
  if (e.DESK_EXECUTION === "delta" && (!deltaApiKey || !deltaApiSecret)) {
    throw new Error("DESK_EXECUTION=delta requires a complete Demo Delta credential pair.");
  }
  const instruments = [...new Set(e.DESK_INSTRUMENTS.split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{3,20}$/.test(s)))];
  const nimKey = e.NVIDIA_NIM_API_KEY || e.NVIDIA_API_KEY;
  return Object.freeze({
    port: e.PORT,
    databasePath: e.DESK_DATABASE_PATH,
    instruments: instruments.length ? instruments : ["BTCUSD"],
    demoMode: e.DESK_DEMO_MODE,
    execution: e.DESK_EXECUTION,
    demoCycleSeconds: e.DESK_DEMO_CYCLE_SECONDS,
    startingBalance: e.DESK_STARTING_BALANCE,
    maxLeverage: live ? Math.min(e.DESK_MAX_LEVERAGE, 25) : e.DESK_MAX_LEVERAGE,
    deltaEnvironment: e.DELTA_ENV,
    deltaApiKey,
    deltaApiSecret,
    liveTradingConfirmed: e.LIVE_TRADING_CONFIRMED === "I_UNDERSTAND_REAL_MONEY",
    ipFamily: e.DELTA_IP_FAMILY,
    analystApiKey: e.ANALYST_API_KEY || nimKey,
    analystBaseUrl: e.ANALYST_BASE_URL || e.NVIDIA_NIM_BASE_URL,
    analystModel: e.ANALYST_MODEL || e.AI_MODEL,
    analystTimeoutMs: e.ANALYST_TIMEOUT_SECONDS * 1000
  });
}
