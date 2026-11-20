import { useSyncExternalStore } from "react";

/**
 * Light, dark, or whatever the device is set to.
 *
 * Per device, in localStorage, like the sync and Jira settings: it is how this
 * screen should look, not part of the plan, so it never enters AppState (which
 * would sync one person's preference to everyone).
 *
 * "system" is the absent default and sets nothing on <html>, leaving
 * `prefers-color-scheme` in tokens.css to decide, so the app follows the OS
 * live. "light" / "dark" set `data-theme`, which the tokens honour over the
 * media query.
 */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_KEY = "planner_theme_v1";

const listeners = new Set<() => void>();

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Put the choice on <html>. Called before the first paint and on change. */
export function applyTheme(choice: ThemeChoice = readTheme()): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
}

export function writeTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage blocked: the choice still applies for this session.
  }
  applyTheme(choice);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window of the app (or browser tab) changed it.
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY) {
      applyTheme();
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The current choice and a setter, kept in step across components. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const choice = useSyncExternalStore<ThemeChoice>(
    subscribe,
    readTheme,
    () => "system",
  );
  return [choice, writeTheme];
}
