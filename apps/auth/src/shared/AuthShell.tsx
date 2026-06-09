// AuthShell.tsx — the centered card layout every auth screen uses. Presentation only (no logic/fetch);
// mobile-first, light, hairline border, one soft shadow. Accessible: the card is labelled by its title.
import type { ReactNode } from "react";
import { BrandLockup } from "./BrandLockup";

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="auth-main">
      <section className="auth-card" aria-labelledby="auth-title">
        <BrandLockup />
        <h1 id="auth-title" className="auth-title">
          {title}
        </h1>
        {subtitle ? <p className="auth-subtitle">{subtitle}</p> : null}
        {children}
        {footer ? <div className="auth-footer">{footer}</div> : null}
      </section>
    </main>
  );
}
