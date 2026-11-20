import type { ReactNode } from "react";

export type Tone =
  "neutral" | "accent" | "success" | "warning" | "danger" | "info";

interface BadgeProps {
  tone?: Tone;
  /** A leading dot in the tone's colour. */
  dot?: boolean;
  /** A leading icon. */
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: string;
}

/** A small rounded status label: "On track", "Behind", "Active", "Proposed". */
export function Badge({
  tone = "neutral",
  dot = false,
  icon,
  children,
  className,
  title,
}: BadgeProps) {
  return (
    <span
      className={`badge badge-${tone}` + (className ? " " + className : "")}
      title={title}
    >
      {dot && <span className="badge-dot" aria-hidden="true" />}
      {icon}
      {children}
    </span>
  );
}

/**
 * A tag tinted with an arbitrary colour (a specialization's category colour,
 * say). The colour drives the text; the background is a light wash of it.
 */
export function ColorTag({
  color,
  children,
  title,
}: {
  color: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      className="color-tag"
      style={{ ["--tag" as string]: color }}
      title={title}
    >
      {children}
    </span>
  );
}
