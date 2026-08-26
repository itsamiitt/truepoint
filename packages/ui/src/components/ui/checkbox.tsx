// checkbox.tsx — a native <input type="checkbox"> (so it submits with NO JavaScript — the "trust this
// device" box must work no-JS). Styled from primitives.css with the house ink fill, matching TpCheckbox:
// the Tailwind version filled with Cobalt, so the package shipped two checkboxes that checked in two
// different colours. Compose inside a <label> for the text.
import type { InputHTMLAttributes } from "react";
import { cn } from "../../cn.ts";

export function Checkbox({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="checkbox" className={cn("tp-ui-checkbox-box", className)} {...props} />;
}
