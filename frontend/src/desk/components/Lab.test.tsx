import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setState } from "../store";
import { BacktestLab } from "./Lab";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("sends an explicit strategy and UTC date range with costs, and surfaces incomplete history", async () => {
  const http = vi.fn().mockResolvedValueOnce(Response.json({ strategies: [{ id: "channel-6", name: "Breakout 6", family: "channel" }] }))
    .mockResolvedValueOnce(Response.json({ instrument: "BTCUSD", resolution: "5m", launchTime: Date.UTC(2024, 0, 1) / 1000, earliestStart: Date.UTC(2024, 0, 1) / 1000 }))
    .mockResolvedValueOnce(Response.json({ ok: false, message: "Incomplete Delta history" }, { status: 422 }));
  vi.stubGlobal("fetch", http);
  setState({ instruments: ["BTCUSD"] });
  render(<BacktestLab />);
  const submit = screen.getByRole("button", { name: "Run backtest" });
  expect(submit).toBeDisabled();
  await screen.findByRole("option", { name: "Breakout 6" });
  expect(await screen.findByText(/BTCUSD listed/)).toHaveTextContent("Earliest eligible 5m candle");
  expect(screen.getByLabelText("From (UTC)")).toHaveAttribute("min", "2024-01-01");
  fireEvent.change(screen.getByLabelText("Strategy candidate"), { target: { value: "channel-6" } });
  fireEvent.click(submit);
  expect(await screen.findByRole("alert")).toHaveTextContent("Incomplete Delta history");
  const [path, init] = http.mock.calls[2]!;
  expect(path).toBe("/api/backtest");
  const req = JSON.parse(init.body);
  expect(req).toMatchObject({ instrument: "BTCUSD", strategyId: "channel-6", resolution: "5m", feeBps: 5.9, slippageBps: 2, spreadBps: 1 });
  expect(req.start % 86400).toBe(0); expect(req.end).toBeGreaterThan(req.start);
  expect(screen.queryByText("Synthetic")).not.toBeInTheDocument();
});
