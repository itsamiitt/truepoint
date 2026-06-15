// separator.tsx — a hairline rule. With `label` it becomes the centered "or" divider between, e.g., the
// SSO/Google button and the password form. Pure CSS — no JS needed.
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../cn.ts";

export function Separator({
  label,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { label?: ReactNode }) {
  if (label != null) {
    return (
      <div
        className={cn("my-4 flex items-center gap-3 text-xs text-[var(--tp-ink-4)]", className)}
        {...props}
      >
        <span className="h-px flex-1 bg-[var(--tp-hairline)]" />
        {label}
        <span className="h-px flex-1 bg-[var(--tp-hairline)]" />
      </div>
    );
  }
  // Decorative hairline (no role) — the visual divider carries no semantic meaning on its own.
  return <div className={cn("my-4 h-px bg-[var(--tp-hairline)]", className)} {...props} />;
}
