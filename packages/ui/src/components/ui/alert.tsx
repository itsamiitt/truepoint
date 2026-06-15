// alert.tsx — inline form messages. `destructive` = plain red text (field/form errors, role="alert");
// `default` = a muted note box (info/confirmation, role="status"). The caller sets the ARIA role.
import { type VariantProps, cva } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../cn.ts";

const alertVariants = cva("text-[13px]", {
  variants: {
    variant: {
      default:
        "rounded-[var(--radius)] border border-input bg-[var(--tp-surface-3)] px-3 py-2 text-muted-foreground",
      destructive: "text-destructive",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Alert({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>) {
  return <div className={cn(alertVariants({ variant }), className)} {...props} />;
}
