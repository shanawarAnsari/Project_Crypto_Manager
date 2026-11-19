import { setTimeout as delay } from "node:timers/promises";
import type { Bar } from "./types.js";

export const intervals = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 } as const;
export type Resolution = keyof typeof intervals;
export interface HistoryRange { instrument: string; resolution: Resolution; start: number; end: number }
export const historyOrigin = "https://api.india.delta.exchange";
export class HistoryError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function fiveYearFloor(now: number) {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(date.getUTCFullYear() - 5);
  return date.getTime() / 1000;
}

export function listingCoverage(instrument: string, resolution: Resolution, launchTime: number, now = Date.now()) {
  const step = intervals[resolution];
  return { instrument, resolution, launchTime, earliestStart: Math.max(fiveYearFloor(now), Math.ceil(launchTime / step) * step) };
}

export async function fetchLaunchTime(instrument: string, http: typeof fetch = fetch): Promise<number> {
  if (!/^[A-Z0-9_-]{1,40}$/.test(instrument)) throw new HistoryError("Unknown instrument.", 400);
  try {
    const raw = await page(new URL(`/v2/products/${instrument}`, historyOrigin), http, AbortSignal.timeout(20000));
    if (raw && typeof raw === "object" && "symbol" in raw && raw.symbol === instrument &&
      "launch_time" in raw && typeof raw.launch_time === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(raw.launch_time)) {
      const seconds = Date.parse(raw.launch_time) / 1000;
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
    }
  } catch { /* Missing metadata must not become an unbounded history request. */ }
  throw new HistoryError(`Delta listing time unavailable for ${instrument}.`, 502);
}

export function validateRange(range: HistoryRange, now = Date.now()) {
  const { instrument, resolution, start, end } = range;
  const step = intervals[resolution];
  if (!/^[A-Z0-9_-]{1,40}$/.test(instrument) || !Object.hasOwn(intervals, resolution))
    throw new HistoryError("Unknown instrument or resolution.", 400);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end || start % step || end % step)
    throw new HistoryError("Use aligned UTC Unix seconds; start is inclusive and end is exclusive.", 400);
  if (start < fiveYearFloor(now) || end > Math.floor(now / (1000 * step)) * step)
    throw new HistoryError("Choose closed candles within the last five years.", 400);
}

const numeric = (v: unknown) => typeof v === "number" || (typeof v === "string" && v.trim()) ? Number(v) : NaN;
function parsePage(raw: unknown, from: number, to: number, step: number): Bar[] {
  if (!Array.isArray(raw)) throw new HistoryError("Delta returned an invalid candle list.", 502);
  const slots = new Array<Bar | undefined>((to - from) / step);
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new HistoryError("Delta returned an invalid candle.", 502);
    const time = numeric(item.time), open = numeric(item.open), high = numeric(item.high), low = numeric(item.low),
      close = numeric(item.close), volume = numeric(item.volume);
    if (!Number.isSafeInteger(time) || time % step || time < from || time >= to ||
        ![open, high, low, close, volume].every(Number.isFinite) || low <= 0 ||
        low > Math.min(open, close) || high < Math.max(open, close) || volume < 0)
      throw new HistoryError("Delta returned an invalid or out-of-range OHLCV candle.", 502);
    const index = (time - from) / step;
    if (slots[index]) throw new HistoryError(`Duplicate Delta candle at ${new Date(time * 1000).toISOString()}.`, 502);
    slots[index] = { time, open, high, low, close, volume };
  }
  const missing = slots.findIndex(b => !b);
  if (missing !== -1) {
    const first = missing === 0 ? slots.find(b => b !== undefined) : undefined;
    const hint = first ? ` First candle returned on this page: ${new Date(first.time * 1000).toISOString()}.` : "";
    throw new HistoryError(
      `Incomplete Delta history: missing ${new Date((from + missing * step) * 1000).toISOString()}.${hint} Try a later or shorter range; no candles were invented.`, 422);
  }
  return slots as Bar[];
}

async function page(url: URL, http: typeof fetch, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const res = await http(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: "error", credentials: "omit" });
    if (res.ok) {
      const payload = await res.json() as { success?: unknown; result?: unknown };
      if (payload?.success !== true) throw new HistoryError("Delta declined the history request.", 502);
      return payload.result;
    }
    await res.body?.cancel();
    if (attempt === 2 || (res.status !== 429 && res.status < 500))
      throw new HistoryError(`Delta history is unavailable (HTTP ${res.status}).`, 502);
    const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
    if (wait > 15) throw new HistoryError("Delta history rate limit reached. Try again later.", 503);
    await delay(Math.max(1, wait) * 1000, undefined, { signal });
  }
}

/** Read-only public market history. Never use a desk account client or substitute test data. */
export async function fetchHistory(range: HistoryRange, options: {
  http?: typeof fetch; signal?: AbortSignal; progress?: (fraction: number) => void; now?: number;
} = {}): Promise<Bar[]> {
  validateRange(range, options.now);
  const { instrument, resolution, start, end } = range;
  const step = intervals[resolution], bars: Bar[] = [];
  const signal = options.signal ?? new AbortController().signal;
  for (let from = start; from < end; ) {
    const to = Math.min(end, from + 2000 * step);
    const url = new URL("/v2/history/candles", historyOrigin);
    url.search = new URLSearchParams({ symbol: instrument, resolution, start: String(from), end: String(to - 1) }).toString();
    let rows: unknown;
    try { rows = await page(url, options.http ?? fetch, signal); }
    catch (err) {
      if (err instanceof HistoryError || signal.aborted) throw err;
      throw new HistoryError("Could not read the public Delta India history endpoint. Try again later.", 502);
    }
    bars.push(...parsePage(rows, from, to, step));
    from = to;
    options.progress?.((from - start) / (end - start));
  }
  return bars;
}
