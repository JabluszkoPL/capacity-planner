// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  THEME_KEY,
  applyTheme,
  readTheme,
  useTheme,
  writeTheme,
} from "./theme";

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("theme", () => {
  it("defaults to the system setting and marks nothing on <html>", () => {
    expect(readTheme()).toBe("system");
    applyTheme();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("stores an explicit choice and applies it", () => {
    writeTheme("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    writeTheme("system");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("ignores a stored value it doesn't know", () => {
    localStorage.setItem(THEME_KEY, "sepia");
    expect(readTheme()).toBe("system");
  });

  it("re-renders every user of the hook on change", () => {
    const a = renderHook(() => useTheme());
    const b = renderHook(() => useTheme());
    act(() => a.result.current[1]("light"));
    expect(b.result.current[0]).toBe("light");
  });
});
