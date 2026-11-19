import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Extra class on the panel, e.g. to widen it. */
  className?: string;
  children: ReactNode;
}

/**
 * Accessible modal.
 *
 * Closing rules (deliberate — this exact area shipped broken in the POC):
 *  - A genuine click on the backdrop closes it. We detect that with
 *    `e.target === e.currentTarget` on the backdrop's own onClick, so a click
 *    that merely *bubbles up* from content inside the panel does NOT close it.
 *  - We intentionally do NOT call stopPropagation() on the panel: that would
 *    also silently swallow clicks on buttons inside the panel if any consumer
 *    relies on bubbling (the bug that made the POC's Import/Cancel dead).
 *  - Escape closes it, and focus returns to whatever was focused before open.
 */
export function Modal({
  open,
  onClose,
  title,
  className,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Keep the latest onClose in a ref so the focus/keydown effect below can
  // depend on `open` alone. Consumers routinely pass an inline arrow for
  // onClose, so if the effect depended on it directly it would re-run on every
  // parent re-render — re-focusing the first focusable element and yanking any
  // scrollable content inside the panel back to the top (e.g. the dependency
  // picker jumping up each time a checkbox is toggled).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    // Move focus into the panel (first focusable, else the panel itself).
    const panel = panelRef.current;
    if (panel) {
      const focusable = panel.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (focusable ?? panel).focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Restore focus to the element that had it before the modal opened.
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={className ? `modal ${className}` : "modal"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
      >
        {title && <h3>{title}</h3>}
        {children}
      </div>
    </div>
  );
}
