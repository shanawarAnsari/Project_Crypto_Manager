import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoCloseAll } from "./DemoCloseAll";

afterEach(cleanup);

describe("Demo close-all confirmation", () => {
  it("excludes external positions and preserves automation after verified success", async () => {
    const close = vi.fn(async () => undefined);
    render(<DemoCloseAll enabled onCloseAll={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Close app-owned Demo BTCUSD trades" }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("group")).toHaveTextContent("Manually opened/external trades and orders and other products are not touched");
    expect(screen.getByRole("group")).toHaveTextContent("running automation continues");
    fireEvent.click(screen.getByRole("button", { name: "Confirm close app-owned Demo BTCUSD" }));
    expect(await screen.findByText(/App-owned Demo close request verified/)).toBeInTheDocument();
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Automation controls are unchanged");
  });
  it("cancels without calling the API", () => {
    const close = vi.fn(async () => undefined);
    render(<DemoCloseAll enabled onCloseAll={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Close app-owned Demo BTCUSD trades" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel close all" }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });
  it("disables unavailable/Live actions and clears confirmation on environment changes", () => {
    const close = vi.fn(async () => undefined);
    const view = render(<DemoCloseAll enabled={false} onCloseAll={close} />);
    expect(screen.getByRole("button", { name: "Close app-owned Demo BTCUSD trades" })).toBeDisabled();
    view.rerender(<DemoCloseAll enabled onCloseAll={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Close app-owned Demo BTCUSD trades" }));
    view.rerender(<DemoCloseAll enabled={false} onCloseAll={close} />);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(close).not.toHaveBeenCalled();
  });
  it("blocks duplicates during the request and surfaces failures without retry", async () => {
    let reject!: (error: Error) => void;
    const close = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    render(<DemoCloseAll enabled onCloseAll={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Close app-owned Demo BTCUSD trades" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm close app-owned Demo BTCUSD" }));
    expect(screen.getByRole("button", { name: "Close app-owned Demo BTCUSD trades" })).toBeDisabled();
    await act(async () => reject(new Error("Demo close-all not confirmed; inspect Delta Demo")));
    expect(screen.getByRole("alert")).toHaveTextContent("not confirmed");
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/App-owned Demo close request verified/)).not.toBeInTheDocument();
  });
});
