import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setState } from "../store";
import { KpiStrip } from "./Header";

afterEach(cleanup);

describe("exchange account dashboard", () => {
  it("does not display paper starting capital when the exchange account is unavailable", () => {
    setState({
      dataSource: "delta", deltaEnv: "testnet", connected: true, account: null,
      kpis: { equity: 10000, balance: 10000, today_pnl: 0, today_pnl_pct: 0, win_rate: 0, trades: 0, open_risk: 0, open_risk_pct: 0, drawdown_pct: 0, dd_limit_pct: 4, kill_switch: false }
    });
    render(<KpiStrip />);
    expect(screen.getByLabelText("Exchange account")).toHaveTextContent("Demo account (not real money)");
    expect(screen.getByText(/ACCOUNT DATA UNAVAILABLE OR STALE/)).toBeInTheDocument();
    expect(screen.queryByText("$10,000.00")).not.toBeInTheDocument();
  });

  it("displays the synced Demo account while orders are disabled", () => {
    setState({
      dataSource: "delta", execution: "disabled", deltaEnv: "testnet", connected: true,
      account: { environment: "testnet", wallet: { balance: 123.45, available: 100, asset: "USD" }, equity: 125, positions: [], updated_at: Date.now() / 1000, error: null }
    });
    render(<KpiStrip />);
    expect(screen.getByText(/Demo account \(not real money\).*Account synced/)).toBeInTheDocument();
    expect(screen.getByText("$123.45")).toBeInTheDocument();
    expect(screen.getByText("$125.00")).toBeInTheDocument();
    expect(screen.getByText("$1.55")).toBeInTheDocument();
    expect(screen.getByText("Account P/L (open)")).toBeInTheDocument();
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
