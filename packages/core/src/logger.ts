import pino, { type Logger } from 'pino';

export type { Logger } from 'pino';

export interface LoggerOptions {
  level?: string;
  name?: string;
  destination?: pino.DestinationStream;
}

// Keys that must never reach logs.
const REDACT_PATHS = [
  'apiKey',
  'apiSecret',
  'secret',
  'password',
  'token',
  'authorization',
  '*.apiKey',
  '*.apiSecret',
  '*.secret',
  '*.password',
  '*.token',
  '*.authorization',
  'DELTA_API_KEY',
  'DELTA_API_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'DATABASE_URL',
];

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      name: options.name,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination,
  );
}
