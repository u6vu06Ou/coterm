import { createElement, type ErrorInfo } from "react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../../src/renderer/src/components/ErrorBoundary";

// Node-environment test: no DOM, no JSX — React.createElement renders plain
// element objects so render() output is asserted structurally.
function makeInfo(): ErrorInfo {
  return { componentStack: "\n    at Child" };
}

describe("ErrorBoundary", () => {
  it("getDerivedStateFromError wraps the caught error instance", () => {
    const error = new Error("boom");
    const state = ErrorBoundary.getDerivedStateFromError(error);
    expect(state.error).toBe(error);
    const nonError = ErrorBoundary.getDerivedStateFromError("plain-string");
    expect(nonError.error).toBeInstanceOf(Error);
    expect(nonError.error.message).toBe("plain-string");
  });

  it("reports message + stack + source, then renders the fallback", () => {
    const reporter = vi.fn();
    const error = new Error("boom");
    const fallback = createElement("div", { "data-testid": "fb" }, "fallback-shown");
    const children = createElement("div", null, "children");
    const instance = new ErrorBoundary({ source: "artifact-preview", fallback, reporter, children });

    // Render normally before a catch.
    expect(instance.render()).toBe(children);

    instance.componentDidCatch(error, makeInfo());
    expect(reporter).toHaveBeenCalledTimes(1);
    const call = reporter.mock.calls[0] as unknown[][];
    expect(call[0]).toBe("boom");
    expect(call[1]).toBe(error.stack ?? "");
    expect(call[2]).toBe("artifact-preview");

    // After the catch the boundary swaps children for the fallback.
    instance.state = { error };
    const rendered = instance.render();
    expect(rendered).toBe(fallback);
    expect((rendered as { props: { children: string } }).props.children).toBe("fallback-shown");
  });

  it("falls back to reportToMain (no reporter) without throwing", () => {
    const error = new Error("sink");
    const instance = new ErrorBoundary({
      source: "window.error",
      children: createElement("div", null, "children"),
    });
    expect(() => instance.componentDidCatch(error, makeInfo())).not.toThrow();
    expect(() => instance.render()).not.toThrow();
  });
});
