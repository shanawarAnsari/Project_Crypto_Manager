export function formatNumber(value: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value.trim() === "") return "—";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(parsed);
}

export function formatMoney(value: string | null | undefined): string {
  const formatted = formatNumber(value);
  return formatted === "—" ? formatted : `${Number(value) < 0 ? "-$" : "$"}${formatted.replace("-", "")}`;
}

export function formatInr(value: string | null | undefined): string {
  const formatted = formatNumber(value);
  return formatted === "—" ? "" : ` · ₹${formatted}`;
}

export function pnlClass(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount === 0) return "text-slate-300";
  return amount > 0 ? "text-terminal-green" : "text-terminal-red";
}

export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "—"
    : date.toLocaleString(undefined, { hour12: false });
}
