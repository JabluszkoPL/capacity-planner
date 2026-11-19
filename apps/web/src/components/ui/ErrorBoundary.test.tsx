// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary, ErrorPanel } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("epic.children is undefined");
}

describe("ErrorBoundary", () => {
  it("shows what broke instead of unmounting everything", () => {
    // React logs the caught error; keep the test output readable.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <p>Header still here</p>
        <ErrorBoundary
          fallback={(error) => <ErrorPanel title="Broke" error={error} />}
        >
          <Boom />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText("Header still here")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "epic.children is undefined",
    );
    spy.mockRestore();
  });

  it("renders its children when nothing throws", () => {
    render(
      <ErrorBoundary fallback={() => <p>fallback</p>}>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeInTheDocument();
    expect(screen.queryByText("fallback")).not.toBeInTheDocument();
  });
});
