import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import type { Tone } from "./Badge";

const TONE_ICON: Record<Tone, IconName> = {
  neutral: "info",
  info: "info",
  accent: "checkCircle",
  success: "checkCircle",
  warning: "alert",
  danger: "alert",
};

interface CalloutProps {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  /** Controls on the right, e.g. a button that resolves it. */
  actions?: ReactNode;
  role?: "status" | "alert" | "note";
}

/** An inline message strip: warnings, "3 rows ready to import", hints. */
export function Callout({
  tone = "info",
  title,
  children,
  actions,
  role,
}: CalloutProps) {
  return (
    <div className={`callout callout-${tone}`} role={role}>
      <Icon name={TONE_ICON[tone]} size={16} className="callout-icon" />
      <div className="callout-body">
        {title && <div className="callout-title">{title}</div>}
        {children}
      </div>
      {actions && <div className="callout-actions">{actions}</div>}
    </div>
  );
}
