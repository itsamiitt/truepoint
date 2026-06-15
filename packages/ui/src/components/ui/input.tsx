// input.tsx — text input (native <input>, so it submits and validates with NO JavaScript). Tailwind-
// themed from TruePoint tokens; turns its border red on aria-invalid. The single grey focus ring comes
// from the global :focus-visible rule in tokens.css.
"use client";

import type { InputHTMLAttributes } from "react";
import { forwardRef } from "react";
import { cn } from "../../cn.ts";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "h-10 w-full rounded-[var(--radius)] border border-input bg-background px-3 text-sm text-foreground",
        "placeholder:text-[var(--tp-ink-4)] aria-[invalid=true]:border-destructive",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
