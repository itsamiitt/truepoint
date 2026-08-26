// separator.tsx — a hairline rule. With `label` it becomes the centered "or" divider between, e.g., the
// SSO/Google button and the password form. Pure CSS — no JS needed. Styled from primitives.css.
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../cn.ts";

export function Separator({
  label,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { label?: ReactNode }) {
  if (label != null) {
    return (
      <div className={cn("tp-ui-separator-labeled", className)} {...props}>
        {label}
      </div>
    );
  }
  // Decorative hairline (no role) — the visual divider carries no semantic meaning on its own.
  return <div className={cn("tp-ui-separator", className)} {...props} />;
}
