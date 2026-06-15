// badge.tsx — a small pill. Used for the locked-identifier chip on the password/verify steps (the email
// the user entered, with a "change" link beside it). Monochrome by default; success uses the Cobalt tint.
import { type VariantProps, cva } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../cn.ts";

const badgeVariants = cva(
  "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px]",
  {
    variants: {
      variant: {
        default: "border-input bg-[var(--tp-surface-3)] text-[var(--tp-ink-2)]",
        success: "border-transparent bg-[var(--tp-cobalt-50)] text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
