import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { MAX_POPUP_HEIGHT, usePopupBox } from "./usePopupBox";

interface ComboInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Called on blur and when an option is picked, with the value to keep. */
  onCommit: (value: string) => void;
  options: string[];
  id?: string;
  "aria-label"?: string;
  placeholder?: string;
}

/**
 * A free-text input with a suggestion list (the ARIA combobox pattern).
 *
 * Unlike a native `<datalist>` — which filters by the current value, so a
 * field that already holds "Backend" suggests nothing but itself — clicking
 * (or ArrowDown) opens the *full* list, and filtering only starts once the
 * user types. Picking an option is never required: whatever is typed is kept.
 *
 * Keyboard: ArrowDown/ArrowUp open and move, Enter picks the highlighted
 * option — otherwise it commits the typed text and blurs, like the other
 * inline fields, or submits the form when the input sits in one. Escape closes
 * the list without leaving the field.
 *
 * The list is portalled to `<body>` with fixed positioning so the task
 * table's `overflow-x: auto` scroll container can't clip it.
 */
export function ComboInput({
  value,
  onChange,
  onCommit,
  options,
  id,
  "aria-label": ariaLabel,
  placeholder,
}: ComboInputProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // null = show every option (just opened); a string = filter by what's typed.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(-1);

  const q = query?.trim().toLowerCase() ?? "";
  const shown = q
    ? options.filter((o) => o.toLowerCase().includes(q))
    : options;
  const expanded = open && shown.length > 0;
  const box = usePopupBox(inputRef, expanded);

  const openList = () => {
    if (open) return;
    setOpen(true);
    setQuery(null);
    const current = value.trim().toLowerCase();
    setActive(options.findIndex((o) => o.toLowerCase() === current));
  };
  const close = () => {
    setOpen(false);
    setQuery(null);
    setActive(-1);
  };
  const pick = (option: string) => {
    onChange(option);
    onCommit(option);
    close();
  };

  // Keep the highlighted option in view when moving with the arrow keys.
  useLayoutEffect(() => {
    if (!expanded || active < 0) return;
    document
      .getElementById(`${listId}-${active}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [expanded, active, listId]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      if (shown.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) =>
        i < 0
          ? step > 0
            ? 0
            : shown.length - 1
          : (i + step + shown.length) % shown.length,
      );
    } else if (e.key === "Enter") {
      if (expanded && active >= 0 && active < shown.length) {
        e.preventDefault();
        pick(shown[active]);
      } else if (!e.currentTarget.form) {
        e.preventDefault();
        e.currentTarget.blur();
      }
    } else if (e.key === "Escape" && expanded) {
      // Close just the list — don't let a surrounding modal see this Escape.
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close();
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={
          expanded && active >= 0 ? `${listId}-${active}` : undefined
        }
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onMouseDown={openList}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setQuery(e.target.value);
          setActive(-1);
        }}
        onBlur={() => {
          close();
          onCommit(value);
        }}
        onKeyDown={onKeyDown}
      />
      {expanded &&
        box &&
        createPortal(
          <ul
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="combo-list"
            style={{ ...box, maxHeight: MAX_POPUP_HEIGHT }}
          >
            {shown.map((o, i) => (
              <li
                key={o}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={
                  "combo-option" +
                  (i === active ? " active" : "") +
                  (o.toLowerCase() === value.trim().toLowerCase()
                    ? " current"
                    : "")
                }
                // Keep focus in the input so blur doesn't fire before click.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
              >
                {o}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
