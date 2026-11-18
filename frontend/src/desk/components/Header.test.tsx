import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setState } from "../store";
import { KpiStrip } from "./Header";

afterEach(cleanup);

describe("exchange account dashboard", () => {
  it("does not display paper starting capital when the exchange account is unavailable", () => {
    setState({
      dataSource: "delta", deltaEnv: "production", connected: true, account: null,
      kpis: { equity: 10000, balance: 10000, today_pnl: 0, today_pnl_pct: 0, win_rate: 0, trades: 0, open_risk: 0, open_risk_pct: 0, drawdown_pct: 0, dd_limit_pct: 4, kill_switch: false }
    });
    render(<KpiStrip />);
    expect(screen.getByLabelText("Exchange account")).toHaveTextContent("LIVE account");
    expect(screen.getByText(/ACCOUNT DATA UNAVAILABLE OR STALE/)).toBeInTheDocument();
    expect(screen.queryByText("$10,000.00")).not.toBeInTheDocument();
  });

  it("displays the synced Demo account while execution remains paper", () => {
    setState({
      dataSource: "delta", execution: "paper", deltaEnv: "testnet", connected: true,
      account: { environment: "testnet", wallet: { balance: 123.45, available: 100, asset: "USD" }, equity: 125, positions: [], updated_at: Date.now() / 1000, error: null }
    });
    render(<KpiStrip />);
    expect(screen.getByText(/DEMO account \(not real money\).*Account synced/)).toBeInTheDocument();
    expect(screen.getByText("$123.45")).toBeInTheDocument();
    expect(screen.getByText("$125.00")).toBeInTheDocument();
  });

  it("marks retained account values stale on a sync error", () => {
    setState({
      dataSource: "delta", connected: true,
      account: { environment: "testnet", wallet: { balance: 123.45, available: 100, asset: "USD" }, equity: 125, positions: [], updated_at: Date.now() / 1000, error: "Authentication failed" }
    });
    render(<KpiStrip />);
    expect(screen.getByRole("alert")).toHaveTextContent("Authentication failed");
    expect(screen.getByText(/ACCOUNT DATA UNAVAILABLE OR STALE/)).toBeInTheDocument();
  });
});
