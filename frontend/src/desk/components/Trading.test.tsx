import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setState } from "../store";
import { SignalFeed, TradeHistory } from "./Trading";

const fetchMock = vi.fn();

beforeEach(() => {
  setState({ journalTick: 0 });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("signal history", () => {
  it("reports journal failures instead of showing an empty history", async () => {
    fetchMock.mockRejectedValue(new Error("Desk offline"));
    render(<SignalFeed />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Signal history unavailable: Desk offline");
    expect(screen.queryByText("No bot decisions recorded yet.")).not.toBeInTheDocument();
  });
});

describe("dashboard trade history", () => {
  it("shows trade prices, quantity, P/L, timing and the analyst rationale", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        decisions: [{
          id: 1, ts: 1, instrument: "BTCUSD", signal_id: "signal-1", outcome: "taken", summary: "Trade opened",
          trace: [{ agent: "Analyst", summary: "Bullish sweep reclaimed the prior low with strong displacement." }]
        }],
        trades: [{
          id: "trade-1", signal_id: "signal-1", instrument: "BTCUSD", direction: "LONG", venue: "paper", volume: 3,
          entry: 65000, exit: 65200, pnl: 12, opened_at: 1700000000, closed_at: 1700003600, reason: "TP2"
        }]
      })
    });
    setState({ journalTick: 0, digits: { BTCUSD: 2 } });
    render(<TradeHistory />);

    expect(await screen.findByText("$12.00")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("65,000.00")).toBeInTheDocument();
    expect(screen.getByText("65,200.00")).toBeInTheDocument();
    expect(screen.getByText("Bullish sweep reclaimed the prior low with strong displacement.")).toBeInTheDocument();
    expect(screen.getByText("TP2")).toBeInTheDocument();
    expect(screen.getByText("1h 0m")).toBeInTheDocument();
  });
});
