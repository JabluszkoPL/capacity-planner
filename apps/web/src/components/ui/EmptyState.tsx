import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  message?: string;
  /** Optional action (e.g. a button) shown beneath the message. */
  children?: ReactNode;
  /** Compact variant for inline/sub-section empty areas. */
  compact?: boolean;
}

/** Shared empty-state block so every "nothing here yet" area looks the same. */
export function EmptyState({
  title,
  message,
  children,
  compact = false,
}: EmptyStateProps) {
  return (
    <div className={"empty-state" + (compact ? " compact" : "")}>
      <p className="empty-title">{title}</p>
      {message && <p className="muted">{message}</p>}
      {children}
    </div>
  );
}
