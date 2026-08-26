// alert.tsx — inline form messages. `destructive` = plain red text (field/form errors, role="alert");
// `default` = a muted note box (info/confirmation, role="status"). The caller sets the ARIA role.
// Styled from primitives.css so it renders in every app (the Tailwind version was invisible outside auth).
import type { HTMLAttributes } from "react";
import { cn } from "../../cn.ts";

export function Alert({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLDivElement> & { variant?: "default" | "destructive" }) {
  return <div className={cn("tp-ui-alert", `tp-ui-alert--${variant}`, className)} {...props} />;
}
