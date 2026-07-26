// stubs/next-link.tsx — next/link as a plain anchor.
//
// The slice uses <Link href> for record deep-links. Inside a preview card there is no router to navigate,
// and letting a click escape the card would break the DS pane, so the anchor renders with its real href
// (the link text and styling are what the card is showing) but swallows the click.
import type { AnchorHTMLAttributes, ReactNode } from "react";

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
  children?: ReactNode;
}

export default function Link({ href, prefetch, replace, scroll, children, onClick, ...rest }: LinkProps) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
