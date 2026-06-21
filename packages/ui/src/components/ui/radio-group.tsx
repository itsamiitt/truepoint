// radio-group.tsx — selectable rows built on native <input type="radio"> (so the org/workspace pickers
// submit with NO JavaScript). The selected row highlights via CSS :has(:checked) — no JS. Give every
// RadioOption in a group the same `name`; mark the first `defaultChecked` so there is always a default.
"use client";

import type { HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../../cn.ts";

export function RadioGroup({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="radiogroup" className={cn("flex flex-col gap-2", className)} {...props}>
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
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-[var(--radius)] border border-input p-3 text-sm",
        "has-[:checked]:border-foreground has-[:checked]:bg-[var(--tp-surface-3)]",
        className,
      )}
    >
      <input type="radio" className="size-4 shrink-0 accent-[var(--tp-cobalt)]" {...props} />
      {children}
    </label>
  );
}
