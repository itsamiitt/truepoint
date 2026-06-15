// label.tsx — form field label (shadcn pattern on Radix Label). Renders a native <label> (works with no
// JS); 13px medium per the auth type scale. Pair with an Input via htmlFor/id.
"use client";

import * as LabelPrimitive from "@radix-ui/react-label";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import { forwardRef } from "react";
import { cn } from "../../cn.ts";

export const Label = forwardRef<
  ElementRef<typeof LabelPrimitive.Root>,
  ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn("mb-1.5 block text-[13px] font-medium text-foreground", className)}
    {...props}
  />
));
Label.displayName = "Label";
