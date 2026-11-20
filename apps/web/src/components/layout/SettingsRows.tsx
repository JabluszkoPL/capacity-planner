import { useId, type ReactNode } from "react";
import { Icon, type IconName } from "../ui/Icon";

interface SettingsGroupProps {
  title: string;
  icon?: IconName;
  /** A status badge on the right of the heading ("Connected", "Off"). */
  status?: ReactNode;
  /** A short muted paragraph under the heading. */
  description?: ReactNode;
  children?: ReactNode;
}

/**
 * One block of the settings dialog: a heading with an optional status badge,
 * then calm rows. Each group is a labelled region, so a screen reader can
 * jump between "Updates", "Sharing" and the rest.
 */
export function SettingsGroup({
  title,
  icon,
  status,
  description,
  children,
}: SettingsGroupProps) {
  const id = useId();
  return (
    <section className="settings-group" aria-labelledby={id}>
      <div className="settings-group-head">
        {icon && <Icon name={icon} size={16} className="settings-group-icon" />}
        <h4 id={id}>{title}</h4>
        {status && <span className="settings-group-status">{status}</span>}
      </div>
      {description && <div className="settings-group-desc">{description}</div>}
      {children}
    </section>
  );
}

interface SettingsRowProps {
  label: ReactNode;
  /** Makes the label a <label> for this control. */
  htmlFor?: string;
  labelId?: string;
  /** Under the label: a hint, a status line, a warning. */
  hint?: ReactNode;
  /** The control: a switch, a value, a button. */
  children?: ReactNode;
  /** Label above a full-width control (an address field and its buttons). */
  stacked?: boolean;
}

/** Label (and hint) on the left, the control on the right. */
export function SettingsRow({
  label,
  htmlFor,
  labelId,
  hint,
  children,
  stacked = false,
}: SettingsRowProps) {
  return (
    <div className={"settings-row" + (stacked ? " stacked" : "")}>
      <div className="settings-row-text">
        {htmlFor ? (
          <label className="settings-row-label" htmlFor={htmlFor} id={labelId}>
            {label}
          </label>
        ) : (
          <div className="settings-row-label" id={labelId}>
            {label}
          </div>
        )}
        {!stacked && hint}
      </div>
      {children !== undefined && (
        <div className="settings-row-control">{children}</div>
      )}
      {stacked && hint}
    </div>
  );
}
