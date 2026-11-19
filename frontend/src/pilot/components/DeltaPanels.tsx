import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { useStore } from "../store/useStore";
import { Glass } from "./Glass";
import { post } from "../lib/api";
import { dateTime, px, usd } from "../lib/format";

const BLOCKING = ["NO_CREDENTIALS", "AUTH_FAILED", "IP_NOT_WHITELISTED", "UNREACHABLE"];

/** Delta India status: connection light, account, wallet/equity, environment, ping, and every failing check with its fix. */
export function DeltaStatusCard({ showActions = true }: { showActions?: boolean }) {
  const delta = useStore((s) => s.delta);
  const account = useStore((s) => s.account);
  const env = useStore((s) => s.deltaEnv);
  const instruments = useStore((s) => s.instruments);
  const [busy, setBusy] = useState<string | null>(null);
  const ready = !!delta?.connected && !!delta.authenticated && !(delta.issues ?? []).some((i) => BLOCKING.includes(i.code));
  const light = !delta ? "bg-slate-500" : ready ? "bg-profit shadow-profit" : delta.connected ? "bg-warn" : "bg-loss shadow-loss";
  const wallet = account?.wallet;
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try { await fn(); } catch { /* toast already shown */ } finally { setBusy(null); }
  };
  return (
    <Glass className="p-4" title="Delta Exchange India" right={
      <span className="flex items-center gap-2 text-[11px] text-slate-300">
        <span className={`h-2.5 w-2.5 rounded-full ${light}`} />
        {!delta ? "Checking…" : ready ? "Ready" : delta.connected ? "Needs attention" : "Disconnected"}
      </span>}>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px]">
        <div className="text-slate-400">Account</div>
        <div className={`text-right font-semibold ${env === "testnet" ? "text-emerald-300" : "text-rose-300"}`}>{env === "testnet" ? "DEMO (testnet)" : "LIVE (real money)"}</div>
        <div className="text-slate-400">Market data</div><div className="text-right text-slate-100">{delta?.connected ? "Connected" : "Offline"}</div>
        <div className="text-slate-400">API key</div><div className="text-right text-slate-100">{delta?.authenticated ? "Verified" : "Not verified"}</div>
        {wallet && (
          <>
            <div className="text-slate-400">Wallet balance</div><div className="num text-right text-slate-100">{px(wallet.balance)} {wallet.asset}</div>
            <div className="text-slate-400">Available</div><div className="num text-right text-slate-100">{px(wallet.available)} {wallet.asset}</div>
            <div className="text-slate-400">Equity</div><div className="num text-right text-slate-100">{account?.equity == null ? "—" : `${px(account.equity)} ${wallet.asset}`}</div>
          </>
        )}
        {env === "production" && (<><div className="text-slate-400">Live trading</div><div className="text-right text-slate-100">{delta?.live_unlocked ? "Unlocked" : "Locked"}</div></>)}
        <div className="text-slate-400">Ping</div><div className="num text-right text-slate-100">{delta?.ping_ms ?? "—"} ms</div>
      </div>
      {account?.error && <p className="mt-2 text-[12px] text-amber-200">Account sync: {account.error}</p>}
      {!!delta?.issues?.length && (
        <ul className="mt-3 space-y-2">
          {delta.issues.map((i) => (
            <li key={i.code} className="rounded-lg border border-warn/30 bg-warn/[0.07] p-2.5 text-[12px]">
              <div className="font-semibold text-amber-200">{i.message}</div>
              <div className="mt-0.5 text-slate-300"><span className="text-amber-300">Fix:</span> {i.fix}</div>
            </li>
          ))}
        </ul>
      )}
      {showActions && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-ghost px-3 py-1.5 text-xs" disabled={!!busy} onClick={() => run("rc", () => post("/api/delta/reconnect"))}>
            {busy === "rc" ? "Checking…" : "↻ Re-check"}
          </button>
          <button className="btn-ghost px-3 py-1.5 text-xs" data-cursor="Test" disabled={!ready || !!busy || env !== "testnet"}
            title={env !== "testnet" ? "Test orders run on the Demo account only" : "Places 1 contract, then closes it"}
            onClick={() => run("test", () => post("/api/delta/test-order", { instrument: instruments[0] ?? "BTCUSD" }))}>
            {busy === "test" ? "Placing & closing…" : `Send test order (1 contract ${instruments[0] ?? "BTCUSD"})`}
          </button>
        </div>
      )}
    </Glass>
  );
}

const KIND_STYLE: Record<string, string> = {
  order_filled: "text-emerald-300", order_send: "text-cyan-200", reduce: "text-cyan-200", modify_sl: "text-violet-200",
  order_refused: "text-rose-300", order_error: "text-rose-300", reduce_error: "text-rose-300", modify_sl_error: "text-rose-300"
};

/** Every Delta request with status, order id and fill price. */
export function DeltaExecutionLog() {
  const log = useStore((s) => s.execLog);
  return (
    <Glass className="flex h-full min-h-0 flex-col p-4" title="Delta execution log" glow="none">
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        {!log.length && <p className="py-6 text-center text-sm text-slate-500">No Delta requests yet. Orders, closes and stop moves appear here live.</p>}
        <table className="w-full text-[11.5px]">
          <tbody>
            <AnimatePresence initial={false}>
              {log.map((r, i) => (
                <motion.tr key={`${r.ts}-${i}`} initial={{ opacity: 0, backgroundColor: "rgba(34,211,238,.15)" }} animate={{ opacity: 1, backgroundColor: "rgba(0,0,0,0)" }}
                  className="border-b border-white/[0.04] align-top">
                  <td className="num whitespace-nowrap py-1.5 pr-2 text-slate-500">{dateTime(r.ts)}</td>
                  <td className={`py-1.5 pr-2 font-semibold ${KIND_STYLE[r.kind] ?? "text-slate-300"}`}>{r.kind}</td>
                  <td className="py-1.5 pr-2 text-slate-300">{r.symbol}</td>
                  <td className="py-1.5 pr-2 text-slate-400">{r.status}</td>
                  <td className="num py-1.5 pr-2 text-slate-300">{r.order_id ? `#${r.order_id}` : "—"}</td>
                  <td className="num py-1.5 pr-2 text-slate-300">{r.price ? px(r.price) : "—"}</td>
                  <td className="py-1.5 text-slate-400">{r.message}</td>
                </motion.tr>
              ))}
            </AnimatePresence>
          </tbody>
        </table>
      </div>
    </Glass>
  );
}

/** Recent account fills from Delta (includes trades placed manually outside the desk). */
export function DeltaFills() {
  const fills = useStore((s) => s.account?.fills ?? []);
  return (
    <Glass className="p-4" title="Delta account fills" glow="none">
      {!fills.length ? <p className="py-4 text-center text-sm text-slate-500">No fills on this account yet.</p> : (
        <table className="mt-2 w-full text-[11.5px]">
          <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
            <tr><th className="py-1">Time</th><th>Symbol</th><th>Side</th><th className="text-right">Size</th><th className="text-right">Price</th><th className="text-right">Fee</th></tr>
          </thead>
          <tbody>
            {fills.slice(0, 15).map((f) => (
              <tr key={f.id} className="border-t border-white/[0.04]">
                <td className="num whitespace-nowrap py-1.5 text-slate-500">{dateTime(f.time)}</td>
                <td className="text-slate-200">{f.symbol}</td>
                <td className={f.side === "buy" ? "text-profit" : "text-loss"}>{f.side.toUpperCase()}</td>
                <td className="num text-right text-slate-300">{f.size}</td>
                <td className="num text-right text-slate-300">{px(f.price)}</td>
                <td className="num text-right text-slate-400">{f.commission === null ? "—" : usd(f.commission)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Glass>
  );
}
