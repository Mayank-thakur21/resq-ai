import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "@/components/ErrorBoundary";

/** Throws while `shouldThrow.current` is true, so tests can "fix" it before resetting. */
function Bomb({ shouldThrow }: { shouldThrow: { current: boolean } }) {
  if (shouldThrow.current) throw new Error("Kaboom");
  return <p>Recovered content</p>;
}

/** React logs caught render errors to console.error; silence that noise per test. */
function silenceConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("shows the default ErrorState and recovers after 'Try again'", async () => {
    silenceConsoleError();
    const user = userEvent.setup();
    const shouldThrow = { current: true };

    render(
      <ErrorBoundary title="Weather is unavailable">
        <Bomb shouldThrow={shouldThrow} />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Weather is unavailable")).toBeInTheDocument();
    // Details (error message) are shown outside production builds.
    expect(screen.getByText("Kaboom")).toBeInTheDocument();

    shouldThrow.current = false;
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(screen.getByText("Recovered content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("calls onError with the error and component stack", () => {
    silenceConsoleError();
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <Bomb shouldThrow={{ current: true }} />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, info] = onError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Kaboom");
    expect(info).toHaveProperty("componentStack");
  });

  it("logs to the console when no onError is given", () => {
    const consoleError = silenceConsoleError();
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={{ current: true }} />
      </ErrorBoundary>,
    );
    expect(
      consoleError.mock.calls.some((args) => String(args[0]).includes("[ErrorBoundary]")),
    ).toBe(true);
  });

  it("supports a render-prop fallback with reset", async () => {
    silenceConsoleError();
    const user = userEvent.setup();
    const shouldThrow = { current: true };

    render(
      <ErrorBoundary
        fallback={(error, reset) => (
          <div>
            <p>Custom: {error.message}</p>
            <button type="button" onClick={reset}>
              Reset widget
            </button>
          </div>
        )}
      >
        <Bomb shouldThrow={shouldThrow} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Custom: Kaboom")).toBeInTheDocument();
    shouldThrow.current = false;
    await user.click(screen.getByRole("button", { name: "Reset widget" }));
    expect(screen.getByText("Recovered content")).toBeInTheDocument();
  });

  it("resets automatically when resetKeys change", () => {
    silenceConsoleError();
    const shouldThrow = { current: true };
    const { rerender } = render(
      <ErrorBoundary resetKeys={["a"]}>
        <Bomb shouldThrow={shouldThrow} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    shouldThrow.current = false;
    rerender(
      <ErrorBoundary resetKeys={["b"]}>
        <Bomb shouldThrow={shouldThrow} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Recovered content")).toBeInTheDocument();
  });

  it("wraps non-Error throws in an Error", () => {
    silenceConsoleError();
    function ThrowsString(): React.ReactNode {
      throw "plain string failure";
    }
    const onError = vi.fn();
    render(
      <ErrorBoundary onError={onError}>
        <ThrowsString />
      </ErrorBoundary>,
    );
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toBe("plain string failure");
  });
});
