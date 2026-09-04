/* ============================================================
   sparkBook · src/ui/Button.tsx
   Variants: primary | secondary | ghost | danger | icon
   Sizes:    sm | md | lg
   ============================================================ */
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { motion, tap } from "@motion/index";
import { Icon } from "./Icon";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: string;
  iconRight?: string;
  loading?: boolean;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, iconRight, loading, block, className, children, disabled, ...rest },
  ref,
) {
  const classes = [
    "btn",
    `btn--${variant}`,
    `btn--${size}`,
    block && "btn--block",
    loading && "is-loading",
    className,
  ].filter(Boolean).join(" ");

  return (
    <motion.button
      ref={ref as never}
      className={classes}
      whileTap={!disabled ? tap : undefined}
      disabled={disabled || loading}
      {...(rest as any)}
    >
      {icon && <Icon name={icon} className="btn__icon" size={size === "sm" ? 14 : 16} />}
      {children && <span className="btn__label">{children}</span>}
      {iconRight && <Icon name={iconRight} className="btn__icon" size={size === "sm" ? 14 : 16} />}
      {loading && <span className="btn__spinner" aria-hidden />}
    </motion.button>
  );
});
