import type { HTMLAttributes, ReactNode } from "react";

interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  /** Heading for the panel. Rendered as an <h2> unless it is already a node. */
  title?: ReactNode;
  /** A muted line beneath the title. */
  subtitle?: ReactNode;
  /** Right-aligned controls in the panel header. */
  actions?: ReactNode;
  /** A leading icon in the header. */
  icon?: ReactNode;
  /** Remove body padding, e.g. for an edge-to-edge table. */
  flush?: boolean;
  /** "muted" is a tinted inset panel, for secondary content. */
  tone?: "default" | "muted";
  children?: ReactNode;
}

/**
 * The basic surface: a bordered card with an optional header row (title,
 * subtitle, actions). Every section of every screen is one of these, so the
 * app reads as one system.
 */
export function Panel({
  title,
  subtitle,
  actions,
  icon,
  flush = false,
  tone = "default",
  className,
  children,
  ...rest
}: PanelProps) {
  const classes = ["panel"];
  if (flush) classes.push("panel-flush");
  if (tone === "muted") classes.push("panel-muted");
  if (className) classes.push(className);
  const hasHeader = title || subtitle || actions;
  return (
    <section className={classes.join(" ")} {...rest}>
      {hasHeader && (
        <div className="panel-header">
          {icon && <span className="panel-icon">{icon}</span>}
          <div className="panel-heading">
            {title &&
              (typeof title === "string" ? (
                <h2 className="panel-title">{title}</h2>
              ) : (
                title
              ))}
            {subtitle && <div className="panel-subtitle">{subtitle}</div>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}
