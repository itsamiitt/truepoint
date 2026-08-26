// button.tsx — the action button (shadcn shape: Radix Slot + `asChild`, so a link can wear a button).
// Primary = Ink fill + white text (never Cobalt); outline/ghost/link cover the secondary auth actions.
//
// Styled from primitives.css (.tp-ui-btn), NOT Tailwind utilities. The utilities only resolved in apps/auth
// — the one app that loads tailwindcss + theme.css — so in web/admin/forge this component put class names in
// the DOM with no CSS behind them and rendered as unstyled markup. It now shares TpButton's exact visual
// contract (36px, same variants, same tokens); the two differ only in that this one takes `asChild`.
"use client";

import { Slot } from "@radix-ui/react-slot";
import type { ButtonHTMLAttributes } from "react";
import { forwardRef } from "react";
import { cn } from "../../cn.ts";

type Variant = "default" | "outline" | "ghost" | "link" | "destructive";
type Size = "default" | "sm" | "full";

/** shadcn variant name → the .tp-ui-btn modifier that paints it. */
const VARIANT_CLASS: Record<Variant, string> = {
  default: "tp-ui-btn--primary",
  outline: "tp-ui-btn--secondary",
  ghost: "tp-ui-btn--ghost",
  link: "tp-ui-btn--link",
  destructive: "tp-ui-btn--danger",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
}

/** Kept as a named export for call sites that style a non-button element to match (e.g. an anchor). */
export function buttonVariants({
  variant = "default",
  size = "default",
  className,
}: { variant?: Variant; size?: Size; className?: string } = {}): string {
  return cn(
    "tp-ui-btn",
    VARIANT_CLASS[variant],
    size === "sm" && "tp-ui-btn--sm",
    size === "full" && "tp-ui-btn--full",
    className,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        // `asChild` renders someone else's element (usually an <a>) — a `type` attribute there is invalid.
        type={asChild ? undefined : (type ?? "button")}
        className={buttonVariants({ variant, size, className })}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
