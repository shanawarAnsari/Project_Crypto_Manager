import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type {
  AgentEvent,
  AgentSnapshot,
  AgentTimeframe,
  AuditEvent,
  Candle,
  Dashboard,
  LiveChartStatus,
  Timeframe,
  Trade,
} from "../domain/types";
import { formatInr, formatMoney, formatNumber, formatTime, pnlClass } from "./format";
import { LIVE_CATCH_UP_LIMIT, mergeCandles } from "./live-candles";
import { connectLiveCandles } from "../api/live-stream";
import { MarketChart } from "./MarketChart";
import { EmptyState, Panel, StatusPill } from "./Status";
import { AgentChat } from "./AgentChat";

type ViewTab = "activity" | "audit" | "trades";
type AgentStreamStatus = "connecting" | "live" | "reconnecting" | "unavailable";

export default function App() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>("5m");
  const [candles, setCandles] = useState<Candle[] | null>(null);
  const [candlesLoading, setCandlesLoading] = useState(true);
  const [candlesError, setCandlesError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveChartStatus>("connecting");
  const candleGeneration = useRef(0);
  const candlesLoaded = useRef(false);
  const pendingLiveCandles = useRef<Candle[]>([]);
  const [tab, setTab] = useState<ViewTab>("activity");
  const [botPending, setBotPending] = useState(false);
  const [killPending, setKillPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [agentSnapshot, setAgentSnapshot] = useState<AgentSnapshot | null>(null);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [agentLoading, setAgentLoading] = useState(true);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentStreamStatus, setAgentStreamStatus] = useState<AgentStreamStatus>("connecting");
  const latestAgentEventId = useRef(0);
  const agentConnectedOnce = useRef(false);
  const dashboardRefreshPending = useRef(false);
  const accountVerified = dashboard?.accountStatus === "available" && !dashboardError;
  const account = accountVerified ? dashboard.account : null;
  const portfolio = accountVerified && !dashboard.portfolioError ? dashboard.portfolio : null;
  const canStartBot = Boolean(accountVerified && dashboard?.executionConfigured &&
    dashboard.environment !== "production" &&
    dashboard.accountEnvironment === "demo" && !dashboard.bot.killSwitch);

  const refreshDashboard = useCallback(async () => {
    if (dashboardRefreshPending.current) return;
    dashboardRefreshPending.current = true;
    setDashboardLoading(true);
    try {
      setDashboard(await api.dashboard());
      setDashboardError(null);
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : "Dashboard request failed.");
    } finally {
      dashboardRefreshPending.current = false;
      setDashboardLoading(false);
    }
  }, []);

  const refreshAgent = useCallback(async () => {
    try {
      const snapshot = await api.agent();
      if (!isAgentSnapshot(snapshot)) throw new Error("The agent returned an invalid status snapshot.");
      setAgentSnapshot(snapshot);
      setAgentEvents((current) => mergeAgentEvents(current, snapshot.events));
      latestAgentEventId.current = Math.max(latestAgentEventId.current, ...snapshot.events.map((event) => event.id), 0);
      setAgentError(null);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Agent status request failed.");
    } finally {
      setAgentLoading(false);
    }
  }, []);

  const loadCandles = useCallback(async (selected: Timeframe) => {
    const generation = ++candleGeneration.current;
    candlesLoaded.current = false;
    pendingLiveCandles.current = [];
    setCandlesLoading(true);
    setCandlesError(null);
    setCandles(null);
    try {
      const response = await api.candles(selected);
      if (generation !== candleGeneration.current) return;
      // Candles pushed while history was loading are merged so no live tick is lost.
      setCandles(mergeCandles(response.candles, pendingLiveCandles.current));
      pendingLiveCandles.current = [];
      candlesLoaded.current = true;
    } catch (error) {
      if (generation !== candleGeneration.current) return;
      setCandlesError(error instanceof Error ? error.message : "Candles request failed.");
    } finally {
      if (generation === candleGeneration.current) setCandlesLoading(false);
    }
  }, []);

  useEffect(() => {
    const catchUp = () => {
      if (!candlesLoaded.current) return;
      const generation = candleGeneration.current;
      void api.candles(timeframe, LIVE_CATCH_UP_LIMIT)
        .then((response) => {
          if (generation !== candleGeneration.current) return;
          setCandles((current) => (current === null ? current : mergeCandles(current, response.candles)));
        })
        .catch(() => undefined);
    };
    return connectLiveCandles(timeframe, {
      onStatus: setLiveStatus,
      onConnected: catchUp,
      onCandle: (candle) => {
        if (!candlesLoaded.current) {
          pendingLiveCandles.current.push(candle);
          return;
        }
        setCandles((current) => (current === null ? current : mergeCandles(current, [candle])));
      },
    });
  }, [timeframe]);

  useEffect(() => {
    void refreshDashboard();
    const intervalId = window.setInterval(() => void refreshDashboard(), 5_000);
    return () => window.clearInterval(intervalId);
  }, [refreshDashboard]);

  useEffect(() => {
    const intervalId = window.setInterval(() => void refreshAgent(), 5_000);
    let disposed = false;
    let eventSource: EventSource | null = null;
    const connect = () => {
      if (disposed) return;
      if (typeof EventSource === "undefined") {
        setAgentStreamStatus("unavailable");
        return;
      }
      try {
        eventSource = api.agentEvents(latestAgentEventId.current || undefined);
      } catch {
        setAgentStreamStatus("unavailable");
        return;
      }
      eventSource.onopen = () => {
        setAgentStreamStatus("live");
        if (agentConnectedOnce.current) void refreshAgent();
        agentConnectedOnce.current = true;
      };
      eventSource.onerror = () => setAgentStreamStatus("reconnecting");
      eventSource.addEventListener("activity", (event) => {
        const agentEvent = parseAgentEvent((event as MessageEvent<string>).data);
        if (!agentEvent) return;
        latestAgentEventId.current = Math.max(latestAgentEventId.current, agentEvent.id);
        setAgentEvents((current) => mergeAgentEvents(current, [agentEvent]));
      });
    };
    void refreshAgent().finally(connect);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      eventSource?.close();
    };
  }, [refreshAgent]);

  useEffect(() => {
    void loadCandles(timeframe);
  }, [loadCandles, timeframe]);

  async function toggleBot() {
    if (!dashboard || (!dashboard.bot.enabled && !canStartBot) || botPending) return;
    setBotPending(true);
    setActionError(null);
    try {
      const result = await api.toggleBot(!dashboard.bot.enabled);
      if (result.enabled !== !dashboard.bot.enabled) {
        throw new Error("The API did not confirm the requested bot state.");
      }
      await refreshDashboard();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Bot update failed.");
    } finally {
      setBotPending(false);
    }
  }

  async function triggerKillSwitch() {
    if (killPending || !window.confirm("Engage the kill switch? This is a risk-control action.")) return;
    setKillPending(true);
    setActionError(null);
    try {
      const result = await api.triggerKillSwitch();
      if (!result.accepted) throw new Error("The API did not accept the kill-switch request.");
      if (["partial", "failed", "unavailable"].includes(result.exchangeActions.status)) {
        setActionError(result.exchangeActions.reason ?? "Local trading is paused, but exchange safety actions did not fully confirm.");
      }
      await refreshDashboard();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Kill-switch request failed.");
    } finally {
      setKillPending(false);
    }

  }

  async function resetRiskLock() {
    if (killPending || !window.confirm("Manually clear the latched risk lock? The bot will remain paused.")) return;
    setKillPending(true);
    setActionError(null);
    try {
      const result = await api.triggerKillSwitch(false);
      if (!result.accepted) throw new Error("The API did not accept the manual risk-lock reset.");
      await refreshDashboard();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Risk-lock reset failed.");
    } finally {
      setKillPending(false);
    }
  }

  async function sendAgentMessage(message: string) {
    const result = await api.sendAgentMessage(message);
    if (result.accepted !== true) throw new Error("The agent did not confirm accepting the message.");
  }

  async function saveAgentSettings(timeframe: AgentTimeframe) {
    const result = await api.saveAgentSettings(timeframe);
    if (!isAgentSnapshot(result) || result.timeframe !== timeframe) {
      throw new Error("The agent did not confirm the requested timeframe.");
    }
    setAgentSnapshot(result);
    setAgentEvents((current) => mergeAgentEvents(current, result.events));
    latestAgentEventId.current = Math.max(latestAgentEventId.current, ...result.events.map((event) => event.id), 0);
    setAgentError(null);
    setTimeframe(result.timeframe);
  }

  async function confirmTestEntry(token: string) {
    try {
      const result = await api.confirmTestEntry(token);
      if (!isAgentSnapshot(result)) throw new Error("Invalid test-entry response. Check System activity before retrying.");
      setAgentSnapshot(result);
      setAgentEvents((current) => mergeAgentEvents(current, result.events));
    } finally {
      await Promise.all([refreshAgent(), refreshDashboard()]);
    }
  }

  return (
    <main className="min-h-screen bg-terminal-base text-terminal-text">
      <header className="topbar">
        <div className="flex min-w-0 items-center gap-3">
          <div className="brand-mark">S</div>
          <div>
            <div className="text-sm font-bold tracking-wide">SUNNY <span className="text-terminal-muted">/ CRYPTO MANAGER</span></div>
            <div className="text-[10px] tracking-wider text-terminal-muted">DELTA EXCHANGE INDIA · RISK TERMINAL</div>
          </div>
        </div>
        <div className="market-strip">
          <div className="market-symbol"><span className="coin-mark">₿</span><span>BTC-PERP</span></div>
          <div className="ticker-item"><span>MARK</span><b>{dashboard ? `$${formatNumber(dashboard.market.markPrice)}` : "—"}</b></div>
          <div className="ticker-item"><span>FUNDING</span><b>{dashboard ? `${formatNumber(dashboard.market.fundingRate, 4)}%` : "—"}</b></div>
          <div className="ticker-item">
            <span>WEBSOCKET</span>
            <b className={dashboard?.market.websocketStatus === "connected" ? "text-terminal-green" : "text-terminal-amber"}>
              {dashboard?.market.websocketStatus ?? "—"}
            </b>
          </div>
        </div>
        <div className="header-controls">
          <EnvironmentBadge environment={dashboard?.environment} />
          <button
            aria-label={dashboard?.bot.enabled ? "Stop bot" : "Start bot"}
            className={`button-small ${dashboard?.bot.enabled ? "button-stop" : "button-start"}`}
            disabled={!dashboard || dashboardLoading || botPending ||
              (!dashboard.bot.enabled && !canStartBot)}
            onClick={() => void toggleBot()}
            type="button"
          >
            {botPending ? "…" : dashboard?.bot.enabled ? "BOT ON" : "BOT OFF"}
          </button>
          <button
            className="button-kill"
            disabled={killPending}
            onClick={() => void triggerKillSwitch()}
            type="button"
          >
            {killPending ? "ENGAGING…" : "KILL SWITCH"}
          </button>
          {dashboard?.bot.killSwitch && (
            <button
              className="button-small button-start"
              disabled={killPending}
              onClick={() => void resetRiskLock()}
              type="button"
            >
              RESET RISK LOCK
            </button>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-[1800px] space-y-4 p-4 lg:p-5">
        <div className="overview-heading">
          <div>
            <p className="overview-eyebrow">Account overview</p>
            <h1 className="overview-title">Trading overview</h1>
            <p className="overview-subtitle">
              <span>Delta Exchange India</span>
              <span className="overview-separator" aria-hidden="true">·</span>
              <span className={`account-indicator ${accountVerified ? "account-indicator-verified" : "account-indicator-unverified"}`}>
                <span className="account-indicator-dot" aria-hidden="true" />
                Account {accountVerified ? "Verified" : "Not verified"}
              </span>
              <span className="overview-separator" aria-hidden="true">·</span>
              <span>Risk checks required for every order</span>
            </p>
          </div>
          <div className="overview-actions">
            {dashboardLoading && <span className="refresh-status" role="status">Refreshing telemetry…</span>}
            <button
              aria-label={dashboardLoading ? "Refreshing dashboard" : "Refresh dashboard"}
              className="overview-refresh"
              disabled={dashboardLoading}
              onClick={() => void refreshDashboard()}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20">
                <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6M16.5 3.5v4h-4" />
              </svg>
              Refresh
            </button>
          </div>
        </div>

        {dashboardError && (
          <div className="error-banner" role="alert">
            <span>{dashboardError}{dashboard ? " Showing last received telemetry." : ""}</span>
            <button className="text-link" onClick={() => void refreshDashboard()} type="button">Retry</button>
          </div>
        )}
        {dashboard && (
          <section aria-label="Account and automation status" className="overview-status-stack">
            {dashboard.environment === "production" ? !accountVerified && (
              <div className="overview-status status-banner-warning" role="status">
                <span className="status-banner-mark" aria-hidden="true">!</span>
                <div>
                  <span className="status-banner-label">Account verification</span>
                  <p>Live account not verified. Account setup or reconciliation is required.</p>
                </div>
              </div>
            ) : (
              <div className="overview-status status-banner-info" role="status">
                <span className="status-banner-mark" aria-hidden="true">i</span>
                <div>
                  <span className="status-banner-label">Testnet environment</span>
                  <p>Production account not selected. This backend is configured for testnet; live credentials cannot verify a production account here.</p>
                </div>
              </div>
            )}
            {(dashboard.environment === "production" || dashboard.accountEnvironment === "live") && (
              <div className="overview-status status-banner-warning" role="status">
                <span className="status-banner-mark" aria-hidden="true">!</span>
                <div>
                  <span className="status-banner-label">Demo-only automation</span>
                  <p>This production account cannot start the agent. The start control is disabled; stop and risk controls remain available.</p>
                </div>
              </div>
            )}
            <div className={`overview-status ${dashboard.bot.killSwitch || (dashboard.bot.enabled && !canStartBot)
              ? "status-banner-danger"
              : dashboard.bot.enabled
                ? "status-banner-success"
                : "status-banner-paused"}`} role="status">
              <span className="status-banner-mark" aria-hidden="true">
                {dashboard.bot.killSwitch || (dashboard.bot.enabled && !canStartBot) ? "!" : dashboard.bot.enabled ? "ON" : "OFF"}
              </span>
              <div>
                <span className="status-banner-label">Automation</span>
                <p>{dashboard.bot.killSwitch || (dashboard.bot.enabled && !canStartBot)
                  ? "Automation blocked. Resolve account or risk issues before execution can proceed."
                  : dashboard.bot.enabled
                    ? "Automation enabled. Eligible signals require fresh account reconciliation and risk approval before each order."
                    : "Automation paused. No automatic entries while the bot is off."}</p>
              </div>
            </div>
            {accountVerified && !dashboard.executionConfigured && (
              <div className="overview-status status-banner-warning" role="status">
                <span className="status-banner-mark" aria-hidden="true">!</span>
                <div>
                  <span className="status-banner-label">Trading readiness</span>
                  <p>Trading setup incomplete. Read-only account telemetry does not authorize order execution.</p>
                </div>
              </div>
            )}
          </section>
        )}
        {actionError && <div className="error-banner" role="alert">{actionError}</div>}
        {dashboard?.bot.killSwitch && (
          <div className="error-banner" role="status">
            Execution is locked{dashboard.bot.riskHaltReason ? `: ${dashboard.bot.riskHaltReason}` : ""}. It will remain paused until manually reset.
          </div>
        )}
        {dashboard && dashboard.accountStatus !== "available" && (
          <div className="error-banner" role="status">
            {dashboard.accountStatus === "partial" ? "Exchange account telemetry is partial" : "Exchange account telemetry unavailable"}
            {dashboard.accountError ? `: ${dashboard.accountError}` : ""}. Empty account values are not estimates.
          </div>
        )}
        {account && !portfolio && (
          <div className="error-banner" role="status">
            Portfolio valuation unavailable: {dashboard?.portfolioError ?? "Refresh the backend to load portfolio telemetry."}
          </div>
        )}

        <section aria-label="Account telemetry" className="kpi-grid">
          <Metric
            className="metric-card-portfolio"
            detail={portfolio ? formatInr(portfolio.totalInr).replace(" · ", "") : ""}
            label="Wallet portfolio (indicative)"
            value={portfolio ? formatMoney(portfolio.totalUsd) : "—"}
          />
          <Metric
            className="metric-card-wallet"
            detail={account ? formatInr(account.equityInr).replace(" · ", "") : ""}
            label="USD trading wallet"
            value={account ? formatMoney(account.equity) : "—"}
          />
          <Metric
            className="metric-card-margin"
            detail={account ? formatInr(account.availableMarginInr).replace(" · ", "") : ""}
            label="Available USD margin"
            value={account ? formatMoney(account.availableMargin) : "—"}
          />
          <Metric label="Margin used" value={account ? formatMoney(account.marginUsed) : "—"} />
          <Metric
            label="Unrealized PnL"
            value={account ? formatMoney(account.unrealizedPnl) : "—"}
            valueClass={account ? pnlClass(account.unrealizedPnl) : ""}
          />
          <Metric
            label="Realized PnL"
            value={account ? formatMoney(account.realizedPnl) : "—"}
            valueClass={account ? pnlClass(account.realizedPnl) : ""}
          />
          <Metric label="Leverage cap" value="2×" />
          <Metric
            label="Drawdown"
            value={account ? `${formatNumber(account.drawdownPercent)}%` : "—"}
            valueClass="text-terminal-amber"
          />
        </section>


        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
          <div className="space-y-4 xl:col-span-7">
            <MarketChart
              candles={candles}
              error={candlesError}
              liveStatus={liveStatus}
              loading={candlesLoading}
              markPrice={dashboard?.market.markPrice ?? null}
              onRetry={() => void loadCandles(timeframe)}
              onTimeframeChange={setTimeframe}
              positions={accountVerified ? dashboard.positions : []}
              timeframe={timeframe}
              trades={dashboard?.trades ?? []}
            />
            <ActivityPanel
              audit={dashboard?.audit ?? []}
              positions={accountVerified ? dashboard.positions : []}
              orders={dashboard?.orders ?? []}
              tab={tab}
              trades={dashboard?.trades ?? []}
              onTabChange={setTab}
              loading={dashboardLoading && !dashboard}
            />
          </div>
          <div className="xl:col-span-5">
            <AgentChat
              accountEnvironment={dashboard?.accountEnvironment ?? null}
              error={agentError}
              events={agentEvents}
              loading={agentLoading}
              onSaveSettings={saveAgentSettings}
              onSend={sendAgentMessage}
              canTestEntry={Boolean(canStartBot && dashboard?.bot.enabled && agentSnapshot?.enabled &&
                !agentSnapshot.busy && !agentSnapshot.trade && !agentError &&
                dashboard.positions.length === 0 && dashboard.orders.length === 0)}
              onPreviewTestEntry={api.previewTestEntry}
              onConfirmTestEntry={confirmTestEntry}
              snapshot={agentSnapshot}
              streamStatus={agentStreamStatus}
            />
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-terminal-border pt-3 text-[10px] text-terminal-muted">
          <span>Sunny Crypto Manager · Risk first · Execution requires RiskApproval</span>
          <span>{dashboard ? dashboard.environment === "production" ? "Delta India · LIVE environment" : "Delta India · TESTNET environment" : "Environment unknown"}</span>
        </footer>
      </div>
    </main>
  );
}

function parseAgentEvent(data: string): AgentEvent | null {
  try {
    const value: unknown = JSON.parse(data);
    return isAgentEvent(value) ? value : null;
  } catch {
    return null;
  }
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "number" &&
    Number.isSafeInteger(candidate.id) &&
    typeof candidate.message === "string" &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt) &&
    !Number.isNaN(new Date(candidate.createdAt).valueOf()) &&
    ["user", "assistant", "activity", "error"].includes(String(candidate.role));
}

function isAgentSnapshot(value: unknown): value is AgentSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const validTimeframes: AgentTimeframe[] = ["1m", "5m", "15m", "30m", "1h"];
  return validTimeframes.includes(candidate.timeframe as AgentTimeframe) &&
    typeof candidate.model === "string" &&
    typeof candidate.configured === "boolean" &&
    typeof candidate.busy === "boolean" &&
    typeof candidate.enabled === "boolean" &&
    candidate.demoOnly === true &&
    (candidate.lastReviewAt === null || (typeof candidate.lastReviewAt === "number" && Number.isFinite(candidate.lastReviewAt))) &&
    (candidate.nextReviewAt === null || (typeof candidate.nextReviewAt === "number" && Number.isFinite(candidate.nextReviewAt))) &&
    (candidate.trade === null || (typeof candidate.trade === "object" && !Array.isArray(candidate.trade))) &&
    Array.isArray(candidate.events) &&
    candidate.events.every(isAgentEvent);
}

function mergeAgentEvents(current: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt || left.id - right.id);
}

function EnvironmentBadge({
  environment,
}: {
  environment?: Dashboard["environment"];
}) {
  if (!environment) return <StatusPill>ENVIRONMENT UNKNOWN</StatusPill>;
  if (environment === "production") return <StatusPill tone="red">LIVE</StatusPill>;
  return <StatusPill tone="amber">TESTNET</StatusPill>;
}

function Metric({
  label,
  value,
  detail,
  valueClass = "",
  className = "",
}: {
  label: string;
  value: string;
  detail?: string;
  valueClass?: string;
  className?: string;
}) {
  return (
    <div className={`metric-card ${className}`}>
      <div className="metric-label">{label}</div>
      <div className={`metric-value mt-1 font-mono font-semibold ${valueClass}`}>{value}</div>
      {detail && <div className="metric-detail">{detail}</div>}
    </div>
  );
}

function ActivityPanel({
  audit,
  positions,
  orders,
  trades,
  tab,
  onTabChange,
  loading,
}: {
  audit: AuditEvent[];
  positions: Dashboard["positions"];
  orders: Dashboard["orders"];
  trades: Trade[];
  tab: ViewTab;
  onTabChange: (tab: ViewTab) => void;
  loading: boolean;
}) {
  return (
    <Panel
      title="ACCOUNT ACTIVITY"
      action={
        <div aria-label="Activity views" className="flex gap-1" role="tablist">
          {([
            ["activity", "Positions / Orders"],
            ["audit", "AI Audit"],
            ["trades", "Trade History"],
          ] as const).map(([value, label]) => (
            <button
              aria-selected={tab === value}
              className={`tab-button ${tab === value ? "tab-active" : ""}`}
              key={value}
              onClick={() => onTabChange(value)}
              role="tab"
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      {loading ? (
        <EmptyState>Loading account activity…</EmptyState>
      ) : tab === "activity" ? (
        <div className="space-y-5 p-4">
          <div>
            <h3 className="subheading">Open positions <span>{positions.length}</span></h3>
            {positions.length === 0 ? <EmptyState>No open positions.</EmptyState> : (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Market</th><th>Side / Qty</th><th>Entry</th><th>Mark</th><th>uPnL</th><th>Lev.</th><th>Stop</th><th>Target</th></tr></thead>
                  <tbody>
                    {positions.map((position) => (
                      <tr key={position.id}>
                        <td className="font-semibold">{position.symbol}</td>
                        <td><span className={position.side === "long" ? "text-terminal-green" : "text-terminal-red"}>{position.side.toUpperCase()}</span><span className="ml-1 text-terminal-muted">{position.quantity}</span></td>
                        <td>{formatNumber(position.entryPrice)}</td>
                        <td>{formatNumber(position.markPrice)}</td>
                        <td className={pnlClass(position.unrealizedPnl)}>{formatMoney(position.unrealizedPnl)}</td>
                        <td>{formatNumber(position.leverage, 1)}×</td>
                        <td>{position.stopPrice ? formatNumber(position.stopPrice) : "—"}</td>
                        <td>{position.takeProfitPrice ? formatNumber(position.takeProfitPrice) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            <h3 className="subheading">Open orders <span>{orders.length}</span></h3>
            {orders.length === 0 ? <EmptyState>No open orders.</EmptyState> : (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Market</th><th>Side</th><th>Type</th><th>Qty</th><th>Limit</th><th>Status</th><th>Placed</th></tr></thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.id}>
                        <td className="font-semibold">{order.symbol}</td><td>{order.side.toUpperCase()}</td><td>{order.type}</td>
                        <td>{order.quantity}</td><td>{order.limitPrice ? formatNumber(order.limitPrice) : "Market"}</td>
                        <td><StatusPill tone="amber">{order.status}</StatusPill></td><td>{formatTime(order.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : tab === "audit" ? (
        <AuditTable audit={audit} />
      ) : (
        <TradeTable trades={trades} />
      )}
    </Panel>
  );
}

function AuditTable({ audit }: { audit: AuditEvent[] }) {
  if (audit.length === 0) return <EmptyState>No AI audit events.</EmptyState>;
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Time</th><th>Decision</th><th>Risk gate</th><th>Reason</th></tr></thead>
        <tbody>
          {audit.map((event) => (
            <tr key={event.id}>
              <td className="whitespace-nowrap">{formatTime(event.occurredAt)}</td><td className="font-semibold">{event.decision}</td>
              <td><StatusPill tone={event.riskApproved ? "green" : "red"}>{event.riskApproved ? "APPROVED" : "REJECTED"}</StatusPill></td>
              <td className="min-w-60 text-terminal-muted">{event.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradeTable({ trades }: { trades: Trade[] }) {
  if (trades.length === 0) return <EmptyState>No trade history.</EmptyState>;
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>Time</th><th>Side</th><th>Price</th><th>Quantity</th><th>Realized PnL</th></tr></thead>
        <tbody>
          {trades.map((trade) => (
            <tr key={trade.id}>
              <td className="whitespace-nowrap">{formatTime(trade.occurredAt)}</td>
              <td className={trade.side === "buy" ? "text-terminal-green" : "text-terminal-red"}>{trade.side.toUpperCase()}</td>
              <td>{formatNumber(trade.price)}</td><td>{trade.quantity}</td>
              <td className={pnlClass(trade.realizedPnl)}>{formatMoney(trade.realizedPnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
