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
    <main className="grid min-h-screen place-items-center px-4 py-6">
      <section
        aria-labelledby="auth-title"
        className="w-full max-w-[400px] rounded-[var(--radius)] border border-[var(--tp-hairline-2)] bg-[var(--tp-surface)] px-6 py-7 shadow-[0_8px_30px_rgba(17,24,39,0.06)]"
      >
        <BrandLockup />
        <h1 id="auth-title" className="mb-1 text-[22px] font-semibold leading-tight">
          {title}
        </h1>
        {subtitle ? <p className="mb-5 text-sm text-[var(--tp-ink-3)]">{subtitle}</p> : null}
        {children}
        {footer ? <div className="mt-4 text-[13px] text-[var(--tp-ink-3)]">{footer}</div> : null}
      </section>
    </main>
  );
}
