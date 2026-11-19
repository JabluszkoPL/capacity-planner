import { useLayoutEffect, useState, type RefObject } from "react";

export interface PopupBox {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
}

export const MAX_POPUP_HEIGHT = 240;

/**
 * Fixed-position box for a list popup anchored to `anchor`: below it, or
 * above when there is more room there than below and less than a full popup.
 * Tracks page scroll, scroll-container scroll and resize while `open`.
 *
 * Popups are portalled to `<body>` so the tables' `overflow-x: auto` scroll
 * containers can't clip them; this is what keeps them next to their input.
 */
export function usePopupBox(
  anchor: RefObject<HTMLElement>,
  open: boolean,
  minWidth = 160,
): PopupBox | null {
  const [box, setBox] = useState<PopupBox | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const width = Math.max(r.width, minWidth);
      setBox(
        below < MAX_POPUP_HEIGHT && r.top > below
          ? { left: r.left, width, bottom: window.innerHeight - r.top + 2 }
          : { left: r.left, width, top: r.bottom + 2 },
      );
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, open, minWidth]);
  return box;
}
