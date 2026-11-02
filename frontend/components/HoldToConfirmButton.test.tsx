import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HoldToConfirmButton } from "@/components/HoldToConfirmButton";

function setup(props: Partial<React.ComponentProps<typeof HoldToConfirmButton>> = {}) {
  const onConfirm = vi.fn();
  render(<HoldToConfirmButton label="Hold to send SOS" onConfirm={onConfirm} {...props} />);
  const button = screen.getByRole("button", { name: /hold to send sos/i });
  return { onConfirm, button };
}

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HoldToConfirmButton", () => {
  it("confirms after a 2 second press-and-hold and fills the progress ring", () => {
    const { onConfirm, button } = setup();
    fireEvent.pointerDown(button, { pointerType: "touch", button: 0 });
    advance(1000);
    const progress = Number(screen.getByTestId("hold-progress").getAttribute("data-progress"));
    expect(progress).toBeGreaterThan(0.3);
    expect(progress).toBeLessThan(0.8);
    expect(onConfirm).not.toHaveBeenCalled();

    advance(1000);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancels when released early and explains why", () => {
    const { onConfirm, button } = setup();
    fireEvent.pointerDown(button, { pointerType: "mouse", button: 0 });
    advance(1200);
    fireEvent.pointerUp(button);
    advance(2000);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("Released too early — nothing was sent.")).toBeInTheDocument();
    expect(screen.getByTestId("hold-progress")).toHaveAttribute("data-progress", "0.00");
  });

  it("cancels when the pointer leaves the button", () => {
    const { onConfirm, button } = setup();
    fireEvent.pointerDown(button, { pointerType: "touch" });
    advance(500);
    fireEvent.pointerLeave(button);
    advance(2000);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ignores secondary mouse buttons", () => {
    const { onConfirm, button } = setup();
    fireEvent.pointerDown(button, { pointerType: "mouse", button: 2 });
    advance(2500);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("supports holding Space or Enter (key repeat ignored) and cancels on early key release", () => {
    const { onConfirm, button } = setup();
    fireEvent.keyDown(button, { key: " " });
    advance(900);
    fireEvent.keyDown(button, { key: " ", repeat: true });
    advance(1100);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(button, { key: " " });

    fireEvent.keyDown(button, { key: "Enter" });
    advance(1000);
    fireEvent.keyUp(button, { key: "Enter" });
    advance(2000);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancels a hold when the button loses focus", () => {
    const { onConfirm, button } = setup();
    fireEvent.keyDown(button, { key: "Enter" });
    advance(1000);
    fireEvent.blur(button);
    advance(2000);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("offers a two-step tap-to-arm alternative that times out", () => {
    const { onConfirm } = setup({ armTimeoutMs: 5000, confirmLabel: "Send SOS now" });
    fireEvent.click(screen.getByRole("button", { name: /tap here to arm/i }));
    const confirm = screen.getByRole("button", { name: "Send SOS now" });
    expect(confirm).toHaveFocus();
    advance(5000);
    expect(screen.queryByRole("button", { name: "Send SOS now" })).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /tap here to arm/i }));
    fireEvent.click(screen.getByRole("button", { name: "Send SOS now" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled or busy", () => {
    const { onConfirm, button } = setup({ disabled: true });
    expect(button).toBeDisabled();
    fireEvent.pointerDown(button);
    advance(2500);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /tap here to arm/i })).toBeDisabled();
  });

  it("shows the busy label", () => {
    render(<HoldToConfirmButton label="Hold to send SOS" busy busyLabel="Sending SOS…" onConfirm={() => {}} />);
    expect(screen.getByRole("button", { name: /sending sos/i })).toHaveAttribute("aria-busy", "true");
  });
});
