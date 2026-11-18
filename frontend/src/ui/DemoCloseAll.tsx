import { useEffect, useRef, useState } from "react";

export function DemoCloseAll({ enabled, onCloseAll }: {
  enabled: boolean;
  onCloseAll: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) setConfirming(false);
  }, [enabled]);

  async function closeAll() {
    if (!enabled || !confirming || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setConfirming(false);
    setError(null);
    setResult(null);
    try {
      await onCloseAll();
      setResult("App-owned Demo close request verified. External trades were not touched. Automation controls are unchanged; running automation may trade again on a later valid signal.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Close-all could not be confirmed. Inspect Delta Demo; no automatic retry.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-terminal-border pt-3">
      {!confirming && <button className="terminal-button text-rose-300" disabled={!enabled || pending}
        onClick={() => { setConfirming(true); setError(null); setResult(null); }}>
        Close app-owned Demo BTCUSD trades
      </button>}
      {confirming && <div role="group" aria-label="Confirm closing app-owned Demo BTCUSD trades" className="space-y-2">
        <p className="text-rose-300">Only app-owned Demo BTCUSD trades (test or scheduled entries) will close.
          Manually opened/external trades and orders and other products are not touched. Uses reduce-only
          market exits after ownership checks; no owned trade is a no-op. On verified success, running
          automation continues and may trade again on a later valid signal. Paused/locked controls stay
          unchanged. Failed or uncertain exits pause and risk-lock automation; inspect Delta Demo, no automatic retry.</p>
        <button className="terminal-button text-rose-300" disabled={!enabled || pending} onClick={() => void closeAll()}>
          Confirm close app-owned Demo BTCUSD
        </button>
        <button className="terminal-button" disabled={pending} onClick={() => setConfirming(false)}>Cancel close all</button>
      </div>}
      {pending && <p role="status">Closing Demo BTCUSD exposure and verifying exchange read-back...</p>}
      {error && <p role="alert" className="text-rose-300">{error}</p>}
      {result && <p role="status">{result}</p>}
    </div>
  );
}
