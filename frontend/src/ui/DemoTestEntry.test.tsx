import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoTestEntry } from "./DemoTestEntry";
import type { DemoTestEntryPreview } from "../domain/types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(enabled = true) {
  const quote: DemoTestEntryPreview = { token: "test-token", expiresAt: Date.now() + 30_000, side: "buy",
    contracts: "1", leverage: 1, entryPrice: "100000", stopPrice: "99000", takeProfitPrice: "102000" };
  const onPreview = vi.fn(async () => quote);
  const onConfirm = vi.fn(async () => undefined);
  const view = render(<DemoTestEntry enabled={enabled} onPreview={onPreview} onConfirm={onConfirm} />);
  return { quote, onPreview, onConfirm, ...view };
}

describe("explicit Demo test confirmation", () => {
  it("only previews until the operator explicitly confirms", async () => {
    const s = setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview Demo test (no order)" }));
    const confirm = await screen.findByRole("button", { name: "Confirm Demo BUY test order" });
    expect(s.onPreview).toHaveBeenCalledWith("buy", 1);
    expect(s.onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("group")).toHaveTextContent("Stop: 99000. Target: 102000");
    fireEvent.click(confirm);
    await waitFor(() => expect(s.onConfirm).toHaveBeenCalledWith("test-token"));
    expect(await screen.findByText(/Demo test request processed/)).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
  it("cancels without submitting", async () => {
    const s = setup();
    fireEvent.click(screen.getByRole("button", { name: "Preview Demo test (no order)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel test" }));
    expect(s.onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
  it("selects 2x, locks selection for its preview and unlocks on cancel", async () => {
    const s = setup();
    const leverage = screen.getByRole("combobox", { name: "Test leverage" });
    expect(leverage).toHaveValue("1");
    expect(screen.getAllByRole("option")).toHaveLength(102);
    expect(screen.getByRole("option", { name: "100x" })).toHaveValue("100");
    fireEvent.change(leverage, { target: { value: "2" } });
    s.onPreview.mockResolvedValueOnce({ ...s.quote, leverage: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Preview Demo test (no order)" }));
    expect(await screen.findByRole("group")).toHaveTextContent("contract at 2x");
    expect(s.onPreview).toHaveBeenCalledWith("buy", 2);
    expect(leverage).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel test" }));
    expect(leverage).toBeEnabled();
    expect(s.onConfirm).not.toHaveBeenCalled();
  });
  it("rejects a preview whose leverage does not match the selection", async () => {
    const s = setup();
    fireEvent.change(screen.getByRole("combobox", { name: "Test leverage" }), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview Demo test (no order)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid");
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(s.onConfirm).not.toHaveBeenCalled();
  });
  it("previews 100x only on explicit selection and confirms its exact token", async () => {
    const s = setup();
    fireEvent.change(screen.getByRole("combobox", { name: "Test leverage" }), { target: { value: "100" } });
    s.onPreview.mockResolvedValueOnce({ ...s.quote, leverage: 100, stopPrice: "99500", takeProfitPrice: "101000" });
    fireEvent.click(screen.getByRole("button", { name: "Preview Demo test (no order)" }));
    expect(await screen.findByRole("group")).toHaveTextContent("contract at 100x");
    expect(screen.getByRole("group")).toHaveTextContent("Stop: 99500. Target: 101000");
    expect(s.onPreview).toHaveBeenCalledWith("buy", 100);
    expect(s.onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Demo BUY test order" }));
    await waitFor(() => expect(s.onConfirm).toHaveBeenCalledWith(s.quote.token));
  });
  it("requires eligibility and discards a preview when controls become unavailable", async () => {
    const s = setup(false);
    expect(screen.getByRole("button", { name: "Preview Demo test (no order)" })).toBeDisabled();
    s.rerender(<DemoTestEntry enabled onPreview={s.onPreview} onConfirm={s.onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview Demo test (no order)" }));
    await screen.findByRole("group");
    s.rerender(<DemoTestEntry enabled={false} onPreview={s.onPreview} onConfirm={s.onConfirm} />);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(s.onConfirm).not.toHaveBeenCalled();
  });
  it("expires the preview without an order", async () => {
    const s = setup();
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Preview Demo test (no order)" })); });
    act(() => vi.advanceTimersByTime(30_001));
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("expired");
    expect(s.onConfirm).not.toHaveBeenCalled();
  });
  it("surfaces errors without automatic retry or a fill claim", async () => {
    const s = setup();
    s.onConfirm.mockRejectedValueOnce(new Error("Order submission is uncertain; automatic retry is disabled"));
    fireEvent.click(screen.getByRole("button", { name: "Preview Demo test (no order)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Demo BUY test order" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("uncertain");
    expect(s.onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
  it("rejects an invalid preview and shows preview failures", async () => {
    const s = setup();
    s.onPreview.mockResolvedValueOnce({ ...s.quote, contracts: "2" });
    fireEvent.click(screen.getByRole("button", { name: "Preview Demo test (no order)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid");
    expect(s.onConfirm).not.toHaveBeenCalled();
    s.onPreview.mockRejectedValueOnce(new Error("Test entry refused: insufficient margin"));
    fireEvent.click(screen.getByRole("button", { name: "Preview Demo test (no order)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("insufficient margin");
  });
});
