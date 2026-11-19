import {
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { MAX_POPUP_HEIGHT, usePopupBox } from "./usePopupBox";

export interface SearchSelectOption {
  value: string;
  label: string;
  /** Heading the option is listed under; typing it matches the whole group. */
  group?: string;
}

interface SearchSelectProps {
  value: string;
  options: SearchSelectOption[];
  onChange: (value: string) => void;
  "aria-label"?: string;
}

/** `q` is already trimmed and lower-cased. */
function matches(option: SearchSelectOption, q: string): boolean {
  return (
    option.label.toLowerCase().includes(q) ||
    (option.group?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * A `<select>` you can type into (the ARIA select-only-plus-filter combobox).
 *
 * Unlike `ComboInput`, the value must be one of the options: typed text only
 * filters, and leaving the field without picking keeps the current choice.
 * While the list is open the input is cleared and shows the current choice as
 * its placeholder, so typing starts a fresh search rather than appending to
 * the label. A query matches option labels and group headings (a heading
 * match shows the whole group), and the first match is highlighted so Enter
 * picks it.
 *
 * Keyboard: ArrowDown/ArrowUp open and move, Enter picks the highlighted
 * option (or opens the list), Escape closes it without leaving the field, Tab
 * closes it and moves on.
 *
 * The list is portalled to `<body>` with fixed positioning so a table's
 * `overflow-x: auto` scroll container can't clip it.
 */
export function SearchSelect({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
}: SearchSelectProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const box = usePopupBox(inputRef, open, 220);

  const currentLabel = options.find((o) => o.value === value)?.label ?? "";
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => matches(o, q)) : options;

  const openList = () => {
    if (open) return;
    setOpen(true);
    setQuery("");
    setActive(options.findIndex((o) => o.value === value));
  };
  const close = () => {
    setOpen(false);
    setQuery("");
    setActive(-1);
  };
  const pick = (option: SearchSelectOption) => {
    if (option.value !== value) onChange(option.value);
    close();
  };

  // Keep the highlighted option in view when moving with the arrow keys.
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    document
      .getElementById(`${listId}-${active}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, listId]);

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
      e.preventDefault();
      if (!open) openList();
      else if (active >= 0 && active < shown.length) pick(shown[active]);
    } else if (e.key === "Escape" && open) {
      // Close just the list — don't let a surrounding modal see this Escape.
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close();
    }
  };

  // Options are flat for keyboard movement; a heading is rendered wherever
  // the group changes from the previous shown option.
  let lastGroup: string | undefined;

  return (
    <span className="search-select">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && active >= 0 && active < shown.length
            ? `${listId}-${active}`
            : undefined
        }
        autoComplete="off"
        placeholder={open ? currentLabel : undefined}
        value={open ? query : currentLabel}
        title={open ? undefined : currentLabel}
        onMouseDown={openList}
        onChange={(e) => {
          const next = e.target.value;
          const nq = next.trim().toLowerCase();
          setOpen(true);
          setQuery(next);
          setActive(nq === "" || options.some((o) => matches(o, nq)) ? 0 : -1);
        }}
        onBlur={close}
        onKeyDown={onKeyDown}
      />
      <span className="search-select-caret" aria-hidden="true">
        ▾
      </span>
      {open &&
        box &&
        createPortal(
          <div
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="combo-list"
            style={{ ...box, maxHeight: MAX_POPUP_HEIGHT }}
          >
            {shown.length === 0 && (
              <div className="combo-empty">No matches for “{query.trim()}”</div>
            )}
            {shown.map((o, i) => {
              const heading =
                o.group !== undefined && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              return (
                <Fragment key={o.value}>
                  {heading !== null && (
                    <div className="combo-group" role="presentation">
                      {heading}
                    </div>
                  )}
                  <div
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={
                      "combo-option" +
                      (o.group !== undefined ? " grouped" : "") +
                      (i === active ? " active" : "") +
                      (o.value === value ? " current" : "")
                    }
                    title={o.group ? `${o.group} / ${o.label}` : o.label}
                    // Keep focus in the input so blur doesn't fire first.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                  >
                    {o.label}
                  </div>
                </Fragment>
              );
            })}
          </div>,
          document.body,
        )}
    </span>
  );
}
