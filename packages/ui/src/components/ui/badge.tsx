// badge.tsx — a small pill. Used for the locked-identifier chip on the password/verify steps (the email the
// user entered, with a "change" link beside it). Monochrome by default; `success` is success-green.
//
// It used to tint success with Cobalt, which meant the package exported two "success" states in two
// different hues (this and StatusBadge) — colour is the whole signal on a badge, so they have to agree.
import type { HTMLAttributes } from "react";
import { cn } from "../../cn.ts";

export function Badge({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: "default" | "success" }) {
  return (
    <span
      className={cn("tp-ui-badge", variant === "success" && "tp-ui-badge--success", className)}
      {...props}
    />
  );
}
