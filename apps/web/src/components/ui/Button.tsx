import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "danger";
  small?: boolean;
}

export function Button({
  variant = "secondary",
  small = false,
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = ["btn"];
  if (variant === "primary") classes.push("primary");
  if (variant === "danger") classes.push("danger");
  if (small) classes.push("small");
  if (className) classes.push(className);
  return <button type={type} className={classes.join(" ")} {...rest} />;
}
