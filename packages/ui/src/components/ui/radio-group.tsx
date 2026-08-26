// radio-group.tsx — selectable rows built on native <input type="radio"> (so the org/workspace pickers
// submit with NO JavaScript). The selected row highlights via CSS :has(:checked) — no JS. Give every
// RadioOption in a group the same `name`; mark the first `defaultChecked` so there is always a default.
// Styled from primitives.css so the rows render in every app, not only apps/auth.
import type { HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../../cn.ts";

export function RadioGroup({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="radiogroup" className={cn("tp-ui-radio-group", className)} {...props}>
      {children}
    </div>
  );
}

export function RadioOption({
  className,
  children,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { children: ReactNode }) {
  return (
    <label className={cn("tp-ui-radio-option", className)}>
      <input type="radio" className="tp-ui-radio" {...props} />
      {children}
    </label>
  );
}
