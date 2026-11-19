import type { ButtonHTMLAttributes } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label — icon buttons have no visible text. */
  label: string;
  danger?: boolean;
}

export function IconButton({
  label,
  danger = false,
  className = "",
  type = "button",
  children,
  ...rest
}: IconButtonProps) {
  const classes = ["icon-btn"];
  if (danger) classes.push("danger");
  if (className) classes.push(className);
  return (
    <button
      type={type}
      className={classes.join(" ")}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
}
