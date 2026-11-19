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
  DESK_EXECUTION: z.enum(["disabled", "paper", "delta"]).default("disabled"),
  DESK_STARTING_BALANCE: z.coerce.number().positive().default(10_000),
  DESK_MAX_LEVERAGE: z.coerce.number().int().min(1).max(2).default(2),
  DELTA_ENV: z.literal("testnet").default("testnet"),
  DELTA_DEMO_API_KEY: z.string().default(""),
  DELTA_DEMO_API_SECRET: z.string().default(""),
  DELTA_IP_FAMILY: z.enum(["4", "auto"]).default("4")
});

export interface DeskConfig {
  port: number;
  databasePath: string;
  instruments: string[];
  execution: "disabled" | "delta";
  startingBalance: number;
  maxLeverage: number;
  deltaEnvironment: "testnet";
  deltaApiKey: string;
  deltaApiSecret: string;
  /** "4" pins outbound connections to IPv4 so Delta API-key IP whitelists (usually IPv4) match. */
  ipFamily: "4" | "auto";
}

export function loadDeskConfig(env: NodeJS.ProcessEnv = process.env): DeskConfig {
  const e = Schema.parse(env);
  const deltaApiKey = e.DELTA_DEMO_API_KEY.trim();
  const deltaApiSecret = e.DELTA_DEMO_API_SECRET.trim();
  if (e.DESK_DEMO_MODE) throw new Error("Synthetic DESK_DEMO_MODE was removed. Use Delta testnet data.");
  if (e.DESK_EXECUTION === "delta" && (!deltaApiKey || !deltaApiSecret)) {
    throw new Error("DESK_EXECUTION=delta requires a complete Demo Delta credential pair.");
  }
  const instruments = [...new Set(e.DESK_INSTRUMENTS.split(",").map((s) => s.trim().toUpperCase()))];
  if (!instruments.every(s => /^[A-Z0-9]{3,20}$/.test(s))) throw new Error("Invalid DESK_INSTRUMENTS");
  return Object.freeze({
    port: e.PORT,
    databasePath: e.DESK_DATABASE_PATH,
    instruments,
    execution: e.DESK_EXECUTION === "delta" ? "delta" : "disabled",
    startingBalance: e.DESK_STARTING_BALANCE,
    maxLeverage: e.DESK_MAX_LEVERAGE,
    deltaEnvironment: e.DELTA_ENV,
    deltaApiKey,
    deltaApiSecret,
    ipFamily: e.DELTA_IP_FAMILY
  });
}
