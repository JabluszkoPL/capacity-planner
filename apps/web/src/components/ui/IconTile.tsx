import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

interface IconTileProps {
  icon?: IconName;
  /** Text instead of an icon, e.g. an initial. */
  text?: string;
  /** Tile tint; defaults to the accent. Any CSS colour. */
  color?: string | null;
  size?: "sm" | "md" | "lg";
}

/** A rounded, tinted square holding an icon: a project's or tracker's mark. */
export function IconTile({ icon, text, color, size = "md" }: IconTileProps) {
  const px = size === "lg" ? 26 : size === "sm" ? 15 : 19;
  return (
    <span
      className={`icon-tile icon-tile-${size}`}
      style={color ? { ["--tile" as string]: color } : undefined}
      aria-hidden="true"
    >
      {icon ? <Icon name={icon} size={px} /> : text}
    </span>
  );
}

/** A person's initial in a tinted circle. */
export function Avatar({
  name,
  color,
  size = "md",
}: {
  name: string;
  color?: string;
  size?: "sm" | "md";
}) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={`avatar avatar-${size}`}
      style={color ? { ["--avatar" as string]: color } : undefined}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

/** A labelled control: label above, control below, optional hint. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={"field" + (className ? " " + className : "")}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}
