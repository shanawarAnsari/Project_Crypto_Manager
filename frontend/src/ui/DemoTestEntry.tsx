import { useEffect, useState } from "react";
import type { DemoTestEntryPreview } from "../domain/types";
import { DemoCloseAll } from "./DemoCloseAll";

export function DemoTestEntry({ enabled, onPreview, onConfirm, closeAllControl }: {
  enabled: boolean;
  onPreview: (side: "buy" | "sell", leverage: number) => Promise<DemoTestEntryPreview>;
  onConfirm: (token: string) => Promise<void>;
  closeAllControl?: { enabled: boolean; onCloseAll: () => Promise<void> };
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [leverage, setLeverage] = useState(1);
  const [preview, setPreview] = useState<DemoTestEntryPreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) setPreview(null);
  }, [enabled]);

  useEffect(() => {
    if (!preview) return;
    const timer = window.setTimeout(() => {
      setPreview(null);
      setError("Test preview expired. Request a new preview; no order was placed by expiry.");
    }, Math.max(0, preview.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [preview]);

  async function prepare() {
    if (!enabled || pending) return;
    setPending(true);
    setPreview(null);
    setError(null);
    setResult(null);
    try {
      const quote = await onPreview(side, leverage);
      if (!quote.token || quote.side !== side || quote.contracts !== "1" || quote.leverage !== leverage ||
          !Number.isFinite(quote.expiresAt) || quote.expiresAt <= Date.now()) {
        throw new Error("Invalid or expired test preview. No order was authorized.");
      }
      setPreview(quote);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Test preview failed.");
    } finally { setPending(false); }
  }

  async function confirm() {
    if (!enabled || pending || !preview) return;
    const quote = preview;
    setPreview(null);
    if (quote.expiresAt <= Date.now()) {
      setError("Test preview expired. Request a new preview.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onConfirm(quote.token);
      setResult("Demo test request processed. Check System activity for fill and bracket confirmation; no automatic retry.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Test entry failed. Check System activity before any new attempt.");
    } finally { setPending(false); }
  }

  return (
    <section aria-label="Demo execution test" className="space-y-2 rounded border border-amber-700/50 p-3 text-xs">
      <h3 className="font-bold text-amber-200">Demo execution test</h3>
      <p>Signal-free plumbing test: one BTCUSD contract at selected leverage (maximum 100x), initial 1% stop / 2% target,
        narrowed if needed to fit planned-loss budgets.
        All risk limits still apply. Not a trading recommendation. The position is not automatically closed.</p>
      <p>Requires a running, unlocked Demo bot, verified account and no existing exposure or orders.</p>
      <label className="field-label" htmlFor="demo-test-side">
        Test side
        <select id="demo-test-side" className="terminal-input" value={side} disabled={!enabled || pending || !!preview}
          onChange={(event) => setSide(event.target.value === "sell" ? "sell" : "buy")}>
          <option value="buy">BUY / long</option>
          <option value="sell">SELL / short</option>
        </select>
      </label>
      <label className="field-label" htmlFor="demo-test-leverage">
        Test leverage
        <select id="demo-test-leverage" className="terminal-input" value={leverage} disabled={!enabled || pending || !!preview}
          onChange={(event) => setLeverage(Number(event.target.value))}>
          {Array.from({ length: 100 }, (_, index) => index + 1).map((value) =>
            <option key={value} value={value}>{value}x</option>)}
        </select>
      </label>
      <p>Default 1x. Lower saved, configured and exchange caps still apply. Cancel a preview to change leverage.
        High leverage can liquidate the Demo position before a stop executes; inspect exact preview prices.</p>
      {!preview && <button className="terminal-button" disabled={!enabled || pending} onClick={() => void prepare()}>
        Preview Demo test (no order)
      </button>}
      {preview && <div className="space-y-2" role="group" aria-label="Confirm Demo test order">
        <p>{preview.side.toUpperCase()} {preview.contracts} BTCUSD contract at {preview.leverage}x.
          Reference entry: {preview.entryPrice}. Stop: {preview.stopPrice}. Target: {preview.takeProfitPrice}.</p>
        <p>Confirmation submits a Demo market order after fresh checks. Fill price may differ.
          Expires at {new Date(preview.expiresAt).toLocaleTimeString()}.</p>
        <button className="terminal-button" disabled={!enabled || pending} onClick={() => void confirm()}>
          Confirm Demo {preview.side.toUpperCase()} test order
        </button>
        <button className="terminal-button" disabled={pending} onClick={() => setPreview(null)}>Cancel test</button>
      </div>}
      {pending && <p role="status">Checking Demo test request...</p>}
      {error && <p role="alert" className="text-rose-300">{error}</p>}
      {result && <p role="status">{result}</p>}
      {closeAllControl && <DemoCloseAll enabled={closeAllControl.enabled} onCloseAll={async () => {
        setPreview(null);
        await closeAllControl.onCloseAll();
      }} />}
    </section>
  );
}
