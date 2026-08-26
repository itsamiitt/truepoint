// input.tsx — text input (native <input>, so it submits and validates with NO JavaScript). Styled from
// primitives.css (.tp-ui-field), so it renders identically to TpInput in every app; turns its border red on
// aria-invalid. The grey focus ring comes from the global :focus-visible rule in tokens.css.
"use client";

import type { InputHTMLAttributes } from "react";
import { forwardRef } from "react";
import { cn } from "../../cn.ts";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = "text", ...props }, ref) => (
    <input ref={ref} type={type} className={cn("tp-ui-field", className)} {...props} />
  ),
);
Input.displayName = "Input";
