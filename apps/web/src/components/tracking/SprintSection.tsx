import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/Button";

/**
 * Sprint planning, kept out of the way at the bottom of a tracker: one
 * button opens it and brings it into view, the same button closes it.
 */
export function SprintSection({ children }: { children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) body.current?.scrollIntoView?.({ block: "start" });
  }, [open]);
  return (
    <section className="sprint-section" aria-labelledby={`${id}-title`}>
      <div className="sprint-section-head">
        <h2 id={`${id}-title`} className="section-title">
          Sprint planning
        </h2>
        <Button
          variant={open ? "secondary" : "primary"}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide sprint planning" : "Plan sprints"}
        </Button>
      </div>
      {open && (
        <div id={`${id}-body`} ref={body} className="sprint-section-body">
          {children}
        </div>
      )}
    </section>
  );
}
