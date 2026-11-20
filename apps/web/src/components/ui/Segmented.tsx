import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when the label is not plain text. */
  ariaLabel?: string;
  disabled?: boolean;
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for assistive tech. */
  label: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * A pill-shaped single choice (Person / Task / Epic, Balanced / Smart). A
 * radiogroup: one tab stop, arrow keys move and select, like native radios.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  className,
}: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((o) => !o.disabled);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dir =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!dir || enabled.length === 0) return;
    e.preventDefault();
    const at = enabled.findIndex((o) => o.value === value);
    const next = enabled[(at + dir + enabled.length) % enabled.length]!;
    onChange(next.value);
    refs.current[options.indexOf(next)]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={
        `segmented segmented-${size}` + (className ? " " + className : "")
      }
      onKeyDown={onKeyDown}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o.ariaLabel}
            tabIndex={checked ? 0 : -1}
            disabled={o.disabled}
            className={"segmented-option" + (checked ? " active" : "")}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
