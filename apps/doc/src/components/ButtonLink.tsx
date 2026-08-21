// ButtonLink.tsx — a navigation link that looks like a button.
//
// Why this exists rather than a DS import: `TpButton` renders a real `<button>` and takes no `asChild`, so it
// cannot navigate; the shadcn `Button` does take `asChild`, but its styling is Tailwind-class-based and this
// app deliberately ships no Tailwind engine, so those classes would resolve to nothing. Wrapping a `<button>`
// in a link, or hanging a router push off a button's onClick, would both give a keyboard or screen-reader
// user the wrong affordance for what is simply a navigation.
//
// So this reuses the design system's OWN button classes from primitives.css (`.tp-ui-btn`), applied to the
// correct element for the job. Nothing here re-implements the look — change the DS and this changes with it.

import Link from "next/link";
import type { ReactNode } from "react";

export function ButtonLink({
  href,
  variant = "primary",
  children,
}: {
  href: string;
  variant?: "primary" | "secondary" | "ghost";
  children: ReactNode;
}) {
  return (
    <Link href={href} className={`tp-ui-btn tp-ui-btn--${variant}`}>
      {children}
    </Link>
  );
}
