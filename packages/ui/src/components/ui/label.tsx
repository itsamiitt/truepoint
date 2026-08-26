// label.tsx — form field label. A native <label> (works with no JS); 13px medium per the type scale.
// Pair with an Input via htmlFor/id.
//
// Radix's Label primitive was dropped: it exists to forward clicks to the control when the label is NOT a
// real <label>, which was never the case here — it cost the package a dependency (and every consumer of it,
// including three apps that could not render this component at all) for behaviour the platform already has.
import type { LabelHTMLAttributes } from "react";
import { forwardRef } from "react";
import { cn } from "../../cn.ts";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is the caller's — this is the label primitive itself, associated by the htmlFor it is given
    <label ref={ref} className={cn("tp-ui-label", className)} {...props} />
  ),
);
Label.displayName = "Label";
