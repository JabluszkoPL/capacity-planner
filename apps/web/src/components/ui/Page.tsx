import type { ReactNode } from "react";

interface PageProps {
  children: ReactNode;
  /** "wide" drops the max-width, for timelines and big tables. */
  width?: "default" | "wide" | "narrow";
  className?: string;
}

/**
 * The page template every route renders into: the main landmark, the content
 * column and its gutters. Compose it with <PageHeader> and <Panel>s.
 */
export function Page({ children, width = "default", className }: PageProps) {
  const classes = ["page"];
  if (width !== "default") classes.push(`page-${width}`);
  if (className) classes.push(className);
  return <main className={classes.join(" ")}>{children}</main>;
}

interface PageHeaderProps {
  /** The page title, set in the display serif. A node so it can be an input. */
  title: ReactNode;
  /** One quiet line beneath the title: dates, counts, a description. */
  subtitle?: ReactNode;
  /** Small text above the title, e.g. a breadcrumb or a back link. */
  eyebrow?: ReactNode;
  /** A leading tile, e.g. <IconTile>. */
  leading?: ReactNode;
  /** Page-level actions, right-aligned. */
  actions?: ReactNode;
  /** Anything that sits under the header row, e.g. a status strip. */
  children?: ReactNode;
}

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  leading,
  actions,
  children,
}: PageHeaderProps) {
  return (
    <header className="page-header">
      {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
      <div className="page-header-row">
        {leading && <div className="page-header-leading">{leading}</div>}
        <div className="page-header-text">
          {typeof title === "string" ? (
            <h1 className="page-title">{title}</h1>
          ) : (
            title
          )}
          {subtitle && <div className="page-subtitle">{subtitle}</div>}
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
