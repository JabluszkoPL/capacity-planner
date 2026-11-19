/**
 * Included/Skipped-style toggle chip. Renders a real <button> with
 * aria-pressed so it's keyboard-operable and has a visible focus state.
 */
interface ChipProps {
  on: boolean;
  onChange: (next: boolean) => void;
  onLabel?: string;
  offLabel?: string;
  disabled?: boolean;
}

export function Chip({
  on,
  onChange,
  onLabel = "Included",
  offLabel = "Skipped",
  disabled = false,
}: ChipProps) {
  return (
    <button
      type="button"
      className={"toggle-chip " + (on ? "on" : "off")}
      aria-pressed={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="toggle-dot" aria-hidden="true" />
      {on ? onLabel : offLabel}
    </button>
  );
}
