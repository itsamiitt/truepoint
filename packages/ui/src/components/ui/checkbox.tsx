// checkbox.tsx — a native <input type="checkbox"> (so it submits with NO JavaScript — the "trust this
// device" box must work no-JS). Tailwind-themed; the check uses the Wolf-Indigo accent. Compose inside a
// <label> for the text.
"use client";

import type { InputHTMLAttributes } from "react";
import { cn } from "../../cn.ts";

export function Checkbox({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn("size-4 shrink-0 rounded border-input accent-[var(--accent)]", className)}
      {...props}
    />
  );
}
