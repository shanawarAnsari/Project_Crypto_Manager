import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setState } from "../store";
import { SignalFeed } from "./Trading";

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
