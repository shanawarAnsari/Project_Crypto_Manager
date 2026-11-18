import { useStore } from "../store/useStore";

export const usd = (v: number, digits = 2) =>
  `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const signed = (v: number, digits = 2) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(digits)}`;

export const px = (v: number | null | undefined, instrument?: string) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = instrument ? (useStore.getState().digits[instrument] ?? (instrument === "BTCUSD" ? 1 : 2)) : 2;
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};

export const timeHM = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

export const dateTime = (ts: number) =>
  new Date(ts * 1000).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Rough capability check: mobile or low-core devices without WebGL2 get the 2D layout. */
export function weakGpu(): boolean {
  try {
    const mobile = window.matchMedia("(max-width: 820px)").matches || /Android|iPhone|iPad/i.test(navigator.userAgent);
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    if (!gl) return true;
    const cores = navigator.hardwareConcurrency ?? 8;
    return mobile || cores <= 2;
  } catch {
    return true;
  }
}
