import { describe, it, expect, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { TitleBar } from "./TitleBar";
import { applyHostAttributes } from "../../lib/hostBridge";

function pretendElectron() {
  window.planner = {
    db: {} as never,
    syncUrl: null,
    platform: "darwin",
    version: "38.0.0",
  };
}

afterEach(() => {
  delete window.planner;
  delete document.documentElement.dataset.host;
  delete document.documentElement.dataset.platform;
});

describe("TitleBar", () => {
  it("renders nothing in a browser tab", () => {
    const { container } = render(<TitleBar />);
    expect(container.querySelector(".titlebar")).toBeNull();
  });

  it("renders a drag strip in the desktop host", () => {
    pretendElectron();
    const { container } = render(<TitleBar />);
    const strip = container.querySelector(".titlebar");
    expect(strip).not.toBeNull();
    // Decorative: it must not appear to assistive tech as content.
    expect(strip).toHaveAttribute("aria-hidden", "true");
  });

  it("flags the host on the document so the stylesheet can reserve space", () => {
    applyHostAttributes();
    expect(document.documentElement.dataset.host).toBeUndefined();

    pretendElectron();
    applyHostAttributes();
    expect(document.documentElement.dataset.host).toBe("electron");
    expect(document.documentElement.dataset.platform).toBe("darwin");
  });
});
