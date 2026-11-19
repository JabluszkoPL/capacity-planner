import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmProvider, useConfirm } from "./ConfirmDialog";

/** Working example: ask for confirmation, record the resolved boolean. */
function Harness() {
  const confirm = useConfirm();
  const [result, setResult] = useState("(none)");
  return (
    <div>
      <button
        onClick={async () => {
          const ok = await confirm("Delete this project?");
          setResult(String(ok));
        }}
      >
        Ask
      </button>
      <span data-testid="result">{result}</span>
    </div>
  );
}

function renderHarness() {
  return render(
    <ConfirmProvider>
      <Harness />
    </ConfirmProvider>,
  );
}

describe("useConfirm", () => {
  it("resolves true when the user confirms", async () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(screen.getByText("Delete this project?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(screen.getByTestId("result")).toHaveTextContent("true"),
    );
  });

  it("resolves false when the user cancels", async () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.getByTestId("result")).toHaveTextContent("false"),
    );
  });

  it("resolves false when dismissed via Escape", async () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.getByTestId("result")).toHaveTextContent("false"),
    );
  });
});
