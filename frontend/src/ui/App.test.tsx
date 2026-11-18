import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { AgentEvent, AgentSnapshot, Dashboard, Order, Position, Timeframe } from "../domain/types";

vi.mock("../api/live-stream", () => ({ connectLiveCandles: () => () => undefined }));

vi.mock("./MarketChart", () => ({
  MarketChart: ({
    timeframe,
    loading,
    error,
    onTimeframeChange,
    positions,
  }: {
    timeframe: Timeframe;
    loading: boolean;
    error: string | null;
    onTimeframeChange: (timeframe: Timeframe) => void;
    positions: Position[];
  }) => (
    <div aria-label="Market chart">
      <span>Chart timeframe: {timeframe}</span>
      <span data-testid="chart-position-count">{positions.length}</span>
      {loading && <span>Loading candles</span>}
      {error && <span role="alert">{error}</span>}
      <button onClick={() => onTimeframeChange("15m")}>15m chart test</button>
    </div>
  ),
}));

const dashboard: Dashboard = {
  market: { symbol: "BTC-PERP", markPrice: "85000.25", fundingRate: "0.0100", websocketStatus: "connected" },
  environment: "testnet",
  accountEnvironment: "demo",
  executionConfigured: true,
  bot: { enabled: false, killSwitch: false, riskStatus: "within_limits", riskHaltReason: "" },
  accountStatus: "available",
  accountError: null,
  portfolio: {
    totalUsd: "12000.00",
    totalInr: "1020000.00",
    holdings: [{ asset: "USD", quantity: "12000", valueUsd: "12000", valueInr: "1020000" }],
  },
  portfolioError: null,
  account: {
    equity: "12000.00",
    availableMargin: "9000.00",
    marginUsed: "3000.00",
    unrealizedPnl: "-12.50",
    realizedPnl: "120.00",
    leverage: "2",
    drawdownPercent: "1.25",
    usdInrRate: "85",
    equityInr: "1020000.00",
    availableMarginInr: "765000.00",
  },
  positions: [],
  orders: [],
  audit: [],
  trades: [],
  strategy: { name: "trendBreakout", parameters: { maxLeverage: "2" }, instruction: "" },
};

const firstEvent: AgentEvent = {
  id: 1,
  role: "assistant",
  message: "I will wait for a closed candle before reviewing.",
  createdAt: 1_731_801_600_000,
};

const agentSnapshot: AgentSnapshot = {
  timeframe: "5m",
  model: "NVIDIA",
  configured: true,
  busy: false,
  enabled: false,
  demoOnly: true,
  lastReviewAt: 1_731_801_600_000,
  nextReviewAt: 1_731_801_900_000,
  trade: null,
  events: [firstEvent],
};

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: string) {
    const event = new MessageEvent(type, { data });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  open() {
    this.onopen?.(new Event("open"));
  }

  fail() {
    this.onerror?.(new Event("error"));
  }

  close() {
    this.closed = true;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

function setupFetch(options: {
  dashboardResponse?: Dashboard;
  agentResponse?: AgentSnapshot;
  handler?: (url: string, init?: RequestInit) => Promise<Response>;
} = {}) {
  const dashboardResponse = options.dashboardResponse ?? dashboard;
  const agentResponse = options.agentResponse ?? agentSnapshot;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (options.handler) return options.handler(url, init);
    if (url === "/api/dashboard") return jsonResponse(dashboardResponse);
    if (url.startsWith("/api/candles")) return jsonResponse({ candles: [] });
    if (url === "/api/agent") return jsonResponse(agentResponse);
    return jsonResponse({ message: `Unexpected request: ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Agent Chat dashboard", () => {
  it("opens loaded conversation history at the bottom with its scrollbar retained", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1200);
    setupFetch();
    render(<App />);
    await screen.findByText(firstEvent.message);
    expect(screen.getByRole("log").scrollTop).toBe(1200);
    expect(screen.getByRole("log")).toHaveClass("overflow-y-auto", "max-h-[34rem]");
  });
  it("follows each new event and refreshed history after scrolling up without moving focus", async () => {
    let height = 1200;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
    const fetchMock = setupFetch();
    render(<App />);
    await screen.findByText(firstEvent.message);
    const log = screen.getByRole("log");
    const source = MockEventSource.instances[0]!;
    act(() => source.open());
    const input = screen.getByRole("textbox", { name: "Message the agent" });
    input.focus();
    let id = firstEvent.id;
    for (const role of ["user", "assistant", "activity", "error"] as const) {
      log.scrollTop = 20;
      fireEvent.scroll(log);
      height += 200;
      const event: AgentEvent = { id: ++id, role, message: `Latest ${role} update`, createdAt: firstEvent.createdAt + id };
      act(() => source.emit("activity", JSON.stringify(event)));
      expect(screen.getByText(event.message)).toBeInTheDocument();
      expect(log.scrollTop).toBe(height);
      expect(input).toHaveFocus();
    }
    log.scrollTop = 0;
    height = 2400;
    const replacement: AgentEvent = { id: ++id, role: "assistant", message: "Latest refreshed history", createdAt: firstEvent.createdAt + id };
    fetchMock.mockImplementation((input) => String(input) === "/api/agent"
      ? jsonResponse({ ...agentSnapshot, events: [replacement] })
      : jsonResponse(dashboard));
    act(() => source.open());
    await screen.findByText(replacement.message);
    expect(log.scrollTop).toBe(height);
  });
  it("offers a separately confirmed Demo close-all while paused/locked without requiring the LLM", async () => {
    let closed = false;
    const fetchMock = setupFetch({ handler: (url) => {
      if (url === "/api/dashboard") return jsonResponse({ ...dashboard, bot: { ...dashboard.bot, killSwitch: true } });
      if (url === "/api/agent") return jsonResponse({ ...agentSnapshot, configured: false });
      if (url.startsWith("/api/candles")) return jsonResponse({ candles: [] });
      if (url === "/api/agent/close-all") { closed = true; return jsonResponse(agentSnapshot); }
      return jsonResponse({ message: "unexpected" }, 404);
    } });
    render(<App />);
    const close = await screen.findByRole("button", { name: "Close app-owned Demo BTCUSD trades" });
    await waitFor(() => expect(close).toBeEnabled());
    expect(screen.getByRole("button", { name: "Preview Demo test (no order)" })).toBeDisabled();
    fireEvent.click(close);
    expect(closed).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm close app-owned Demo BTCUSD" }));
    await screen.findByText(/App-owned Demo close request verified/);
    expect(closed).toBe(true);
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/agent/close-all");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ confirmation: "CLOSE_OWNED_DEMO_BTCUSD" });
  });
  it("never enables the Demo close-all control for a Live account", async () => {
    setupFetch({ dashboardResponse: { ...dashboard, environment: "production", accountEnvironment: "live" } });
    render(<App />);
    await screen.findByText(firstEvent.message);
    expect(screen.getByRole("button", { name: "Close app-owned Demo BTCUSD trades" })).toBeDisabled();
  });
  it("accepts a verified owned-close response with automation still running", async () => {
    setupFetch({ handler: (url) => {
      if (url === "/api/dashboard") return jsonResponse({ ...dashboard, bot: { ...dashboard.bot, enabled: true } });
      if (url === "/api/agent" || url === "/api/agent/close-all") return jsonResponse({ ...agentSnapshot, enabled: true, trade: null });
      if (url.startsWith("/api/candles")) return jsonResponse({ candles: [] });
      return jsonResponse({ message: "unexpected" }, 404);
    } });
    render(<App />);
    const close = await screen.findByRole("button", { name: "Close app-owned Demo BTCUSD trades" });
    await waitFor(() => expect(close).toBeEnabled());
    fireEvent.click(close);
    fireEvent.click(screen.getByRole("button", { name: "Confirm close app-owned Demo BTCUSD" }));
    expect(await screen.findByText(/App-owned Demo close request verified/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop bot" })).toBeEnabled();
    expect(screen.queryByText(/Close-all response could not be verified/)).not.toBeInTheDocument();
  });
  it("distinguishes stop-loss and target orders with exact trigger prices and preserves exchange pending state", async () => {
    const base: Order = { id: "stop", symbol: "BTCUSD", side: "buy", type: "market_order", quantity: "1",
      stopOrderType: "stop_loss_order", triggerPrice: "64463.8", limitPrice: null, status: "pending",
      createdAt: "2026-11-17T18:32:23Z" };
    setupFetch({ dashboardResponse: { ...dashboard, orders: [
      base, { ...base, id: "target", stopOrderType: "take_profit_order", triggerPrice: "62549.1" },
      { ...base, id: "unknown", stopOrderType: "new_type", triggerPrice: "63000" },
      { ...base, id: "missing", triggerPrice: null },
      { ...base, id: "regular", stopOrderType: null, triggerPrice: null, type: "limit_order", limitPrice: "62000", status: "open" }
    ] } });
    render(<App />);
    const target = await screen.findByText("Take profit / target");
    const targetRow = within(target.closest("tr")!);
    expect(targetRow.getByRole("cell", { name: "62,549.10" })).toBeInTheDocument();
    expect(targetRow.getByText("Awaiting trigger")).toBeInTheDocument();
    expect(targetRow.getByText("Exchange: pending")).toBeInTheDocument();
    const stops = screen.getAllByText("Stop loss");
    expect(within(stops[0]!.closest("tr")!).getByRole("cell", { name: "64,463.80" })).toBeInTheDocument();
    expect(within(stops[1]!.closest("tr")!).getByRole("cell", { name: "Unavailable" })).toBeInTheDocument();
    expect(screen.getByText("Conditional (unclassified)")).toBeInTheDocument();
    expect(screen.getByText("new_type")).toBeInTheDocument();
    const regular = within(screen.getByText("Order", { exact: true }).closest("tr")!);
    expect(regular.getByRole("cell", { name: "Not applicable" })).toBeInTheDocument();
    expect(regular.getByText("open", { exact: true })).toBeInTheDocument();
  });
  it("wires explicit test preview/confirmation and refreshes the position, stop, target and PnL", async () => {
    let confirmed = false;
    const position: Position = { id: "test", symbol: "BTCUSD", side: "long", quantity: "1",
      entryPrice: "100000", markPrice: "100100", unrealizedPnl: "0.10", leverage: "1",
      stopPrice: "99000", takeProfitPrice: "102000" };
    const fetchMock = setupFetch({ handler: (url) => {
      if (url === "/api/dashboard") return jsonResponse({ ...dashboard, bot: { ...dashboard.bot, enabled: true },
        positions: confirmed ? [position] : [] });
      if (url.startsWith("/api/candles")) return jsonResponse({ candles: [] });
      if (url === "/api/agent") return jsonResponse({ ...agentSnapshot, enabled: true, trade: confirmed ? { status: "open" } : null });
      if (url === "/api/agent/test-entry/preview") return jsonResponse({ token: "test-token", expiresAt: Date.now() + 30_000,
        side: "buy", contracts: "1", leverage: 2, entryPrice: "100000", stopPrice: "99000", takeProfitPrice: "102000" });
      if (url === "/api/agent/test-entry/confirm") {
        confirmed = true;
        return jsonResponse({ ...agentSnapshot, enabled: true, trade: { status: "open" } });
      }
      return jsonResponse({ message: "unexpected" }, 404);
    } });
    render(<App />);
    const preview = await screen.findByRole("button", { name: "Preview Demo test (no order)" });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.change(screen.getByRole("combobox", { name: "Test leverage" }), { target: { value: "2" } });
    fireEvent.click(preview);
    const confirm = await screen.findByRole("button", { name: "Confirm Demo BUY test order" });
    const previewRequest = fetchMock.mock.calls.find(([url]) => url === "/api/agent/test-entry/preview");
    expect(JSON.parse(String(previewRequest?.[1]?.body))).toEqual({ side: "buy", leverage: 2 });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/test-entry/confirm")).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByTestId("chart-position-count")).toHaveTextContent("1"));
    expect(screen.getByRole("columnheader", { name: "Target" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "$0.10" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "99,000.00" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "102,000.00" })).toBeInTheDocument();
    const confirmation = fetchMock.mock.calls.find(([url]) => url === "/api/agent/test-entry/confirm");
    expect(JSON.parse(String(confirmation?.[1]?.body))).toEqual({ token: "test-token", confirmation: "PLACE_DEMO_TEST_ORDER" });
  });
  it("polls account PnL every five seconds and hides stale positions when telemetry fails", async () => {
    const interval = vi.spyOn(window, "setInterval");
    let fail = false;
    const position: Position = { id: "test", symbol: "BTCUSD", side: "long", quantity: "1",
      entryPrice: "100000", markPrice: "100100", unrealizedPnl: "0.10", leverage: "1",
      stopPrice: "99000", takeProfitPrice: "102000" };
    setupFetch({ handler: (url) => {
      if (url === "/api/dashboard") return fail ? jsonResponse({ message: "Account offline" }, 503)
        : jsonResponse({ ...dashboard, positions: [position] });
      if (url.startsWith("/api/candles")) return jsonResponse({ candles: [] });
      if (url === "/api/agent") return jsonResponse(agentSnapshot);
      return jsonResponse({ message: "unexpected" }, 404);
    } });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("chart-position-count")).toHaveTextContent("1"));
    const poll = interval.mock.calls.find(([, delay]) => delay === 5_000)?.[0];
    expect(typeof poll).toBe("function");
    fail = true;
    await act(async () => { if (typeof poll === "function") await poll(); });
    await waitFor(() => expect(screen.getByTestId("chart-position-count")).toHaveTextContent("0"));
    expect(screen.queryByRole("cell", { name: "$0.10" })).not.toBeInTheDocument();
  });
  it("distinguishes complete LLM proposals from system risk and execution updates", async () => {
    const proposal = [
      "Scheduled 5m review", "Action: OPEN", "Side: BUY", "Requested margin: 10% of USD equity",
      "Requested leverage: 1x", "Proposed stop: 84000", "Proposed target: 87000",
      "Summary: A confirmed breakout.", "Proposal only; independent risk checks and exchange confirmation follow."
    ].join("\n");
    setupFetch({ agentResponse: { ...agentSnapshot, events: [
      { ...firstEvent, message: proposal },
      { ...firstEvent, id: 2, role: "activity", message: "Trade skipped by risk checks: target does not cover fees" }
    ] } });
    render(<App />);
    const log = await screen.findByRole("log");
    await screen.findByText((_content, element) => element?.tagName === "P" && element.textContent === proposal);
    expect(log).toHaveTextContent("LLM response");
    expect(log).toHaveTextContent("System activity");
    expect(log).toHaveTextContent("Requested margin: 10% of USD equity");
    expect(log).toHaveTextContent("Proposed stop: 84000");
    expect(log).toHaveTextContent("Trade skipped by risk checks: target does not cover fees");
    expect(log).not.toHaveTextContent("Entry fill confirmed");
  });

  it("renders persisted history, agent status, policy, account cards, and the 5m chart default", async () => {
    setupFetch();
    render(<App />);

    expect(await screen.findByText(firstEvent.message)).toBeInTheDocument();
    expect(screen.getByText("NVIDIA")).toBeInTheDocument();
    expect(screen.getByText("DEMO-ONLY")).toBeInTheDocument();
    expect(screen.getByText("Maximum 100% of equity as margin")).toBeInTheDocument();
    expect(screen.getByText("Maximum leverage: 100×")).toBeInTheDocument();
    expect(screen.getByText("Planned stop plus fees ≤30% of total USD equity")).toBeInTheDocument();
    expect(screen.getByText("Maximum 5 entries per UTC day")).toBeInTheDocument();
    expect(screen.getByText("Daily loss limit: 50%")).toBeInTheDocument();
    expect(screen.getByText("Chart timeframe: 5m")).toBeInTheDocument();
    expect(screen.getAllByText("$12,000.00")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Account telemetry" }).querySelectorAll(".metric-card")).toHaveLength(8);
    expect(screen.queryByText(/AI CONTROL DECK|Strategy|Apply strategy|Force AI Re-Evaluate/)).not.toBeInTheDocument();
  });

  it("posts chat only as a future-decision message and disables the composer while pending", async () => {
    let resolveChat!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveChat = resolve; });
    const fetchMock = setupFetch({
      handler: (url) => {
        if (url === "/api/dashboard") return jsonResponse(dashboard);
        if (url.startsWith("/api/candles")) return jsonResponse({ candles: [] });
        if (url === "/api/agent") return jsonResponse(agentSnapshot);
        if (url === "/api/agent/chat") return pending;
        return jsonResponse({ message: "Unexpected request" }, 404);
      },
    });
    render(<App />);
    const input = await screen.findByLabelText("Message the agent");
    fireEvent.change(input, { target: { value: "Please consider volatility at the next review." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(input).toBeDisabled();
    expect(fetchMock.mock.calls.find(([url]) => url === "/api/agent/chat")?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ message: "Please consider volatility at the next review." }),
    });
    expect(screen.getByRole("log")).not.toHaveTextContent("Please consider volatility at the next review.");

    await act(async () => resolveChat(new Response(JSON.stringify({ accepted: true }), { status: 202 })));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(screen.getByRole("log")).not.toHaveTextContent("Please consider volatility at the next review.");
  });

  it("surfaces API chat errors and preserves the message for retry", async () => {
    setupFetch({
      handler: (url) => {
        if (url === "/api/dashboard") return jsonResponse(dashboard);
        if (url.startsWith("/api/candles")) return jsonResponse({ candles: [] });
        if (url === "/api/agent") return jsonResponse(agentSnapshot);
        if (url === "/api/agent/chat") return jsonResponse({ message: "Provider unavailable" }, 503);
        return jsonResponse({ message: "Unexpected request" }, 404);
      },
    });
    render(<App />);
    const input = await screen.findByLabelText("Message the agent");
    fireEvent.change(input, { target: { value: "Review this market context" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider unavailable");
    expect(input).toHaveValue("Review this market context");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  });

  it("adds only valid SSE events, deduplicates replay, and refreshes the snapshot after reconnect", async () => {
    const fetchMock = setupFetch();
    render(<App />);
    await screen.findByText(firstEvent.message);
    const source = MockEventSource.instances[0]!;
    expect(source.url).toBe("/api/agent/events?after=1");
    act(() => source.open());
    expect(await screen.findByText("Live activity connected.")).toBeInTheDocument();

    const liveEvent: AgentEvent = {
      id: 2,
      role: "activity",
      message: "Closed candle received.",
      createdAt: firstEvent.createdAt + 1_000,
    };
    act(() => source.emit("activity", JSON.stringify(liveEvent)));
    expect(await screen.findByText(liveEvent.message)).toBeInTheDocument();
    act(() => {
      source.emit("activity", JSON.stringify(liveEvent));
      source.emit("activity", "{not json");
    });
    expect(screen.getAllByText(liveEvent.message)).toHaveLength(1);

    act(() => source.fail());
    expect(screen.getByText(/Activity feed reconnecting/)).toBeInTheDocument();
    act(() => source.open());
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/agent")).toHaveLength(2));
    expect(source.closed).toBe(false);
  });

  it("saves the agent timeframe and synchronizes the chart only after confirmation", async () => {
    const fetchMock = setupFetch({
      handler: (url, init) => {
        if (url === "/api/dashboard") return jsonResponse(dashboard);
        if (url.startsWith("/api/candles")) return jsonResponse({ candles: [] });
        if (url === "/api/agent") return jsonResponse(agentSnapshot);
        if (url === "/api/agent/settings") {
          expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ timeframe: "15m" }) });
          return jsonResponse({ ...agentSnapshot, timeframe: "15m" });
        }
        return jsonResponse({ message: "Unexpected request" }, 404);
      },
    });
    render(<App />);
    const selector = await screen.findByLabelText("Review timeframe");
    fireEvent.change(selector, { target: { value: "15m" } });

    await waitFor(() => expect(selector).toHaveValue("15m"));
    expect(screen.getByText("Chart timeframe: 15m")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/candles?tf=15m")).toBe(true);
  });

  it("shows provider unavailable state and disables chat without inventing agent history", async () => {
    setupFetch({ agentResponse: { ...agentSnapshot, configured: false, model: "", events: [] } });
    render(<App />);
    expect(await screen.findByText("Provider unavailable: the agent API key is not configured.")).toBeInTheDocument();
    expect(screen.getByText("No conversation history yet.")).toBeInTheDocument();
    expect(screen.getByLabelText("Message the agent")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("blocks starts for production accounts while preserving stop and kill controls", async () => {
    setupFetch({
      dashboardResponse: {
        ...dashboard,
        environment: "production",
        accountEnvironment: "live",
        bot: { ...dashboard.bot, enabled: true },
      },
    });
    render(<App />);
    expect(await screen.findByText(/This production account cannot start the agent/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop bot" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "KILL SWITCH" })).toBeEnabled();
  });

  it("keeps Start disabled whenever the exchange environment is production", async () => {
    setupFetch({
      dashboardResponse: {
        ...dashboard,
        environment: "production",
      },
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Start bot" })).toBeDisabled();
    expect(screen.getByText(/Demo-only automation/)).toBeInTheDocument();
  });

  it("continues to require verified account telemetry before starting automation", async () => {
    setupFetch({
      dashboardResponse: { ...dashboard, accountStatus: "unavailable" },
    });
    render(<App />);
    expect(await screen.findByText(/Exchange account telemetry unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("$12,000.00")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start bot" })).toBeDisabled();
  });
  it("retains wallet cards without the holdings panel or live verification sentence", async () => {
    setupFetch({
      dashboardResponse: {
        ...dashboard,
        environment: "production",
        accountEnvironment: "live",
        account: { ...dashboard.account, equity: "6.078542095", equityInr: "516.68" },
        portfolio: {
          totalUsd: "8.671500715",
          totalInr: "737.08",
          holdings: [
            { asset: "USD", quantity: "6.078542095", valueInr: "516.676078075", valueUsd: "6.078542095" },
            { asset: "BTC", quantity: "0.00003297", valueInr: "220.403921925", valueUsd: "2.5929873167647058824" },
          ],
        },
      },
    });
    render(<App />);
    const telemetry = await screen.findByRole("region", { name: "Account telemetry" });
    expect(await screen.findByText("$8.67")).toBeInTheDocument();
    expect(screen.getByText("₹737.08")).toBeInTheDocument();
    expect(screen.getByText("$6.08")).toBeInTheDocument();
    expect(screen.getByText("₹516.68")).toBeInTheDocument();
    expect(telemetry.querySelectorAll(".metric-detail")).toHaveLength(3);
    expect(screen.queryByText("WALLET HOLDINGS")).not.toBeInTheDocument();
    expect(screen.queryByText(/BTC: 0.00003297/)).not.toBeInTheDocument();
    expect(screen.queryByText("Live account verified (real money).")).not.toBeInTheDocument();
    expect(screen.getByText("2×")).toBeInTheDocument();
  });

  it("reports unavailable portfolio valuation without hiding verified USD funds", async () => {
    setupFetch({ dashboardResponse: { ...dashboard, portfolio: null, portfolioError: "Portfolio valuation unavailable" } });
    render(<App />);
    expect(await screen.findByText(/Portfolio valuation unavailable:/)).toBeInTheDocument();
    expect(screen.getByText("$12,000.00")).toBeInTheDocument();
    expect(screen.getByText("₹1,020,000.00")).toBeInTheDocument();
  });

  it("shows API errors rather than invented account values or agent history", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    render(<App />);
    expect(screen.getByText("Refreshing telemetry…")).toBeInTheDocument();
    expect(await screen.findAllByText(/Could not reach the Sunny API/)).not.toHaveLength(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(await screen.findByText("Conversation history is unavailable.")).toBeInTheDocument();
    expect(screen.getByLabelText("Message the agent")).toBeDisabled();
  });

  it("starts Demo automation only after API confirmation and refresh", async () => {
    let enabled = false;
    const fetchMock = setupFetch({
      handler: (url) => {
        if (url === "/api/dashboard") return jsonResponse({ ...dashboard, bot: { ...dashboard.bot, enabled } });
        if (url.startsWith("/api/candles")) return jsonResponse({ candles: [] });
        if (url === "/api/agent") return jsonResponse(agentSnapshot);
        if (url === "/api/bot/toggle") {
          enabled = true;
          return jsonResponse({ enabled: true });
        }
        return jsonResponse({ message: "Unexpected request" }, 404);
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Start bot" }));
    expect(await screen.findByRole("button", { name: "Stop bot" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.find(([url]) => url === "/api/bot/toggle")?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ enabled: true }),
    });
  });

  it.each([
    { status: "available", configured: false, locked: false },
    { status: "partial", configured: true, locked: false },
    { status: "available", configured: true, locked: true },
  ] as const)("blocks Demo starts when execution readiness is missing: %j", async ({ status, configured, locked }) => {
    setupFetch({
      dashboardResponse: {
        ...dashboard,
        accountStatus: status,
        executionConfigured: configured,
        bot: { ...dashboard.bot, killSwitch: locked },
      },
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Start bot" })).toBeDisabled();
    if (!configured) expect(screen.getByText(/Trading setup incomplete/)).toBeInTheDocument();
  });

  it("keeps Stop available when account telemetry becomes unavailable", async () => {
    setupFetch({
      dashboardResponse: { ...dashboard, accountStatus: "unavailable", bot: { ...dashboard.bot, enabled: true } },
    });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Stop bot" })).toBeEnabled();
    expect(screen.getByText(/Automation blocked/)).toBeInTheDocument();
  });

  it("does not show environment-specific connectivity while loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(<App />);
    expect(screen.queryByText(/connected/)).not.toBeInTheDocument();
    expect(screen.getByText("Environment unknown")).toBeInTheDocument();
  });

  it("loads the selected chart timeframe without changing agent settings", async () => {
    const fetchMock = setupFetch();
    render(<App />);
    fireEvent.click(await screen.findByText("15m chart test"));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/candles?tf=15m")).toBe(true));
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/agent/settings")).toBe(false);
  });

  it("revokes verified balances after a failed dashboard refresh", async () => {
    let dashboardCalls = 0;
    setupFetch({
      handler: (url) => {
        if (url === "/api/dashboard") {
          dashboardCalls += 1;
          return dashboardCalls === 1 ? jsonResponse(dashboard) : Promise.reject(new Error("offline"));
        }
        if (url.startsWith("/api/candles")) return jsonResponse({ candles: [] });
        if (url === "/api/agent") return jsonResponse(agentSnapshot);
        return jsonResponse({ message: "Unexpected request" }, 404);
      },
    });
    render(<App />);
    expect(await screen.findAllByText("₹1,020,000.00")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    expect(await screen.findByText(/Showing last received telemetry/)).toBeInTheDocument();
    expect(screen.queryByText("$12,000.00")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start bot" })).toBeDisabled();
  });

  it("does not offer direct position controls", async () => {
    setupFetch({
      dashboardResponse: {
        ...dashboard,
        positions: [{
          id: "demo-position-1",
          symbol: "BTCUSD",
          side: "long",
          quantity: "1",
          entryPrice: "85000",
          markPrice: "85100",
          unrealizedPnl: "100",
          leverage: "1",
          stopPrice: "84000",
          takeProfitPrice: "87000",
        }],
      },
    });
    render(<App />);
    expect(await screen.findByText("BTCUSD")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });
});
