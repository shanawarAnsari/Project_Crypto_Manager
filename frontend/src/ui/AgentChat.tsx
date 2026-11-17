import { useState, type FormEvent } from "react";
import type { AgentEvent, AgentSnapshot, AgentTimeframe, DemoTestEntryPreview } from "../domain/types";
import { Panel, StatusPill } from "./Status";
import { DemoTestEntry } from "./DemoTestEntry";

type EventStreamStatus = "connecting" | "live" | "reconnecting" | "unavailable";

const TIMEFRAMES: AgentTimeframe[] = ["1m", "5m", "15m", "30m", "1h"];

export function AgentChat({
  snapshot,
  events,
  loading,
  error,
  streamStatus,
  accountEnvironment,
  onSend,
  onSaveSettings,
  canTestEntry,
  onPreviewTestEntry,
  onConfirmTestEntry,
}: {
  snapshot: AgentSnapshot | null;
  events: AgentEvent[];
  loading: boolean;
  error: string | null;
  streamStatus: EventStreamStatus;
  accountEnvironment: "demo" | "live" | "unconfigured" | null;
  onSend: (message: string) => Promise<void>;
  onSaveSettings: (timeframe: AgentTimeframe) => Promise<void>;
  canTestEntry: boolean;
  onPreviewTestEntry: (side: "buy" | "sell") => Promise<DemoTestEntryPreview>;
  onConfirmTestEntry: (token: string) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const demoOnlyBlocked = accountEnvironment === "live";
  const unavailable = snapshot?.configured === false;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = message.trim();
    if (!text || text.length > 2000 || sending || !snapshot?.configured) return;
    setSending(true);
    setChatError(null);
    try {
      await onSend(text);
      setMessage("");
    } catch (sendError) {
      setChatError(sendError instanceof Error ? sendError.message : "Message was not accepted.");
    } finally {
      setSending(false);
    }
  }

  async function updateTimeframe(timeframe: AgentTimeframe) {
    if (savingSettings) return;
    setSavingSettings(true);
    setSettingsError(null);
    try {
      await onSaveSettings(timeframe);
    } catch (saveError) {
      setSettingsError(saveError instanceof Error ? saveError.message : "Agent settings could not be saved.");
    } finally {
      setSavingSettings(false);
    }
  }

  return (
    <Panel
      className="agent-chat-panel"
      title="AGENT CHAT"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone="amber">DEMO-ONLY</StatusPill>
          <StatusPill tone={snapshot?.enabled ? "green" : "neutral"}>
            {snapshot ? snapshot.enabled ? "RUNNING" : "PAUSED" : "STATUS UNKNOWN"}
          </StatusPill>
        </div>
      }
    >
      <div className="space-y-4 p-4">
        {demoOnlyBlocked && (
          <div className="rounded border border-amber-700/50 bg-amber-950/30 p-3 text-xs text-amber-200" role="status">
            Demo-only mode: this production account cannot start the agent. Stop and risk controls remain available.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 rounded border border-terminal-border bg-slate-950/40 p-3 text-xs">
          <div>
            <div className="text-[9px] font-bold uppercase tracking-wider text-terminal-muted">Model</div>
            <div className="mt-1 break-all text-terminal-text">{snapshot?.model || (loading ? "Loading…" : "Unavailable")}</div>
          </div>
          <div>
            <div className="text-[9px] font-bold uppercase tracking-wider text-terminal-muted">Next review</div>
            <div className="mt-1 text-terminal-text">{formatReviewTime(snapshot?.nextReviewAt ?? null)}</div>
          </div>
          <div>
            <div className="text-[9px] font-bold uppercase tracking-wider text-terminal-muted">Last review</div>
            <div className="mt-1 text-terminal-text">{formatReviewTime(snapshot?.lastReviewAt ?? null)}</div>
          </div>
          <div>
            <div className="text-[9px] font-bold uppercase tracking-wider text-terminal-muted">Current trade</div>
            <div className="mt-1 text-terminal-text">{snapshot ? snapshot.trade ? "Trade context available" : "None" : "Unknown"}</div>
          </div>
        </div>

        <label className="field-label" htmlFor="agent-timeframe">
          Review timeframe
          <select
            className="terminal-input"
            disabled={!snapshot || savingSettings}
            id="agent-timeframe"
            onChange={(event) => void updateTimeframe(event.target.value as AgentTimeframe)}
            value={snapshot?.timeframe ?? ""}
          >
            {!snapshot && <option value="">Unavailable</option>}
            {TIMEFRAMES.map((timeframe) => <option key={timeframe} value={timeframe}>{timeframe}</option>)}
          </select>
        </label>
        {savingSettings && <p className="text-xs text-terminal-muted" role="status">Saving settings and pausing automation…</p>}
        {settingsError && <p className="text-xs text-rose-300" role="alert">{settingsError}</p>}

        <section aria-label="Agent conversation">
          <p className="mb-2 text-[10px] leading-relaxed text-terminal-muted">
            LLM responses show the validated action, rationale and proposed trade settings. System activity reports
            data checks, risk decisions and exchange results; these stages do not make separate LLM calls.
          </p>
          <div
            aria-live="polite"
            aria-relevant="additions"
            className="min-h-72 max-h-[34rem] space-y-3 overflow-y-auto rounded border border-terminal-border bg-[#0b1016] p-3"
            role="log"
          >
            {events.length > 0 ? events.map((item) => <ChatEvent event={item} key={item.id} />) : (
              <p className="py-12 text-center text-xs text-terminal-muted">
                {loading ? "Loading conversation history…" : error ? "Conversation history is unavailable." : "No conversation history yet."}
              </p>
            )}
          </div>
        </section>

        <div className="space-y-1 text-[11px]">
          {unavailable && <p className="text-amber-300" role="status">Provider unavailable: the agent API key is not configured.</p>}
          {error && <p className="text-rose-300" role="alert">Agent status unavailable: {error}</p>}
          {streamStatus === "connecting" && <p className="text-terminal-muted" role="status">Connecting to live agent activity…</p>}
          {streamStatus === "reconnecting" && <p className="text-amber-300" role="status">Activity feed reconnecting; conversation history is being refreshed.</p>}
          {streamStatus === "unavailable" && <p className="text-amber-300" role="status">Live activity feed unavailable. Status polling continues.</p>}
          {streamStatus === "live" && <p className="text-terminal-green" role="status">Live activity connected.</p>}
          {snapshot?.busy && <p className="text-terminal-muted" role="status">Agent is processing an update.</p>}
        </div>

        <div className="rounded border border-terminal-border bg-slate-900/40 p-3">
          <h3 className="text-[9px] font-bold uppercase tracking-wider text-terminal-muted">Execution policy</h3>
          <ul className="mt-2 grid gap-1 text-[11px] text-slate-300 sm:grid-cols-2">
            <li>Maximum 25% of equity as margin</li>
            <li>Maximum leverage: 2×</li>
            <li>Planned stop plus fees ≤5% of allocation</li>
            <li>Maximum 5 entries per UTC day</li>
            <li>Daily loss limit: 10%</li>
          </ul>
        </div>
        <p className="text-[10px] leading-relaxed text-terminal-muted">
          Chat messages inform future decisions only; they cannot enable automation or place trades. Decision notes show concise rationales and observable steps, not private reasoning.
        </p>

        <DemoTestEntry enabled={canTestEntry} onPreview={onPreviewTestEntry} onConfirm={onConfirmTestEntry} />

        <form className="space-y-2" onSubmit={(event) => void submit(event)}>
          <label className="field-label" htmlFor="agent-message">
            Message the agent
            <textarea
              className="terminal-input min-h-24 resize-y"
              disabled={sending || unavailable || !snapshot}
              id="agent-message"
              maxLength={2000}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={unavailable ? "Provider unavailable" : "Share context for a future decision…"}
              value={message}
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] text-terminal-muted">{message.length}/2000</span>
            <button
              className="button-primary"
              disabled={sending || unavailable || !snapshot || !message.trim()}
              type="submit"
            >
              {sending ? "Sending…" : "Send message"}
            </button>
          </div>
          {chatError && <p className="text-xs text-rose-300" role="alert">{chatError}</p>}
        </form>
      </div>
    </Panel>
  );
}

function ChatEvent({ event }: { event: AgentEvent }) {
  const roleLabels: Record<AgentEvent["role"], string> = {
    user: "You",
    assistant: "LLM response",
    activity: "System activity",
    error: "Error",
  };
  const color = event.role === "error" ? "text-rose-300" : event.role === "user" ? "text-sky-300" : "text-terminal-text";
  return (
    <article className="rounded border border-terminal-border/70 bg-slate-900/40 p-3">
      <div className="mb-1 flex items-center justify-between gap-3 text-[10px]">
        <span className={`font-bold uppercase tracking-wider ${color}`}>{roleLabels[event.role]}</span>
        <time className="text-terminal-muted" dateTime={new Date(event.createdAt).toISOString()}>
          {new Date(event.createdAt).toLocaleTimeString(undefined, { hour12: false })}
        </time>
      </div>
      <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-200">{event.message}</p>
    </article>
  );
}

function formatReviewTime(timestamp: number | null): string {
  if (timestamp === null) return "Not scheduled";
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? "Unavailable" : date.toLocaleString(undefined, { hour12: false });
}
