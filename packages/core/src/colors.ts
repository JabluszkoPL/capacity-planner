/**
 * Deterministic categorical color for a specialization string.
 * Ported from the POC; palette matches the --cat-* tokens in tokens.css.
 * Shared by the team swatches (T08) and the schedule gantt bars (T10).
 */
const PALETTE = [
  "#4C6EF5",
  "#12B886",
  "#F59F00",
  "#E64980",
  "#7048E8",
  "#15AABF",
  "#FA5252",
  "#82C91E",
  "#FD7E14",
  "#1098AD",
];
const FALLBACK = "#9aa0ab";

/**
 * Preset title colors for tagging a project as an "option" at a glance.
 * The labels are suggestions (used as swatch tooltips); the user still writes
 * their own free-text comment. `value: null` clears the color (default text).
 */
export const TITLE_COLORS: { label: string; value: string | null }[] = [
  { label: "Default", value: null },
  { label: "Best / preferred option", value: "#12B886" },
  { label: "Good option", value: "#4C6EF5" },
  { label: "High", value: "#F59F00" },
  { label: "Low risk", value: "#15AABF" },
  { label: "Not real", value: "#FA5252" },
];

export function colorFor(str: string): string {
  const s = String(str ?? "")
    .trim()
    .toLowerCase();
  if (!s) return FALLBACK;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
