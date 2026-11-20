import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  small?: boolean;
  /** A leading line icon. */
  icon?: IconName;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  small = false,
  icon,
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const classes = ["btn"];
  if (variant !== "secondary") classes.push(variant);
  if (small) classes.push("small");
  if (className) classes.push(className);
  return (
    <button type={type} className={classes.join(" ")} {...rest}>
      {icon && <Icon name={icon} size={small ? 13 : 15} />}
      {children}
    </button>
  );
}
