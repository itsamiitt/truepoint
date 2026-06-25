// AccountShell.tsx — the layout for the signed-in /account/security surface. Presentation only (no logic /
// fetch). Wider than AuthShell (this is a settings surface, not a single-purpose auth card), with a labelled
// in-page section nav that deep-link anchors (#password / #mfa / #sessions / #history) target — so the
// apps/web SecurityPanel "Manage on the sign-in site" links land on the right section. WCAG 2.2 AA: the page
// is one labelled <main>, the nav is a labelled landmark, and each section is reachable by keyboard.
import type { ReactNode } from "react";
import { BrandLockup } from "./BrandLockup";

export interface AccountSection {
  id: string;
  label: string;
}

export function AccountShell({
  title,
  subtitle,
  sections,
  children,
}: {
  title: string;
  subtitle?: string;
  sections: AccountSection[];
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-[760px] px-4 py-8" aria-labelledby="account-title">
      <BrandLockup />
      <header className="mb-6">
        <h1 id="account-title" className="text-[26px] font-semibold leading-tight">
          {title}
        </h1>
        {subtitle ? <p className="mt-1 text-sm text-[var(--tp-ink-3)]">{subtitle}</p> : null}
      </header>

      {sections.length > 0 ? (
        <nav aria-label="Account security sections" className="mb-8">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {sections.map((s) => (
              <li key={s.id}>
                <a
                  className="underline underline-offset-2 text-[var(--tp-ink-3)] hover:text-foreground"
                  href={`#${s.id}`}
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}

      <div className="flex flex-col gap-8">{children}</div>
    </main>
  );
}

/** One titled card section on the account surface. `id` is the deep-link anchor; the heading labels the card. */
export function AccountSectionCard({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="scroll-mt-6 rounded-[var(--radius)] border border-[var(--tp-hairline-2)] bg-[var(--tp-surface)] px-6 py-6 shadow-[0_8px_30px_rgba(17,24,39,0.06)]"
    >
      <h2 id={headingId} className="text-[17px] font-semibold leading-tight">
        {title}
      </h2>
      {description ? (
        <p className="mt-1 mb-4 text-[13px] text-[var(--tp-ink-3)]">{description}</p>
      ) : (
        <div className="mb-4" />
      )}
      {children}
    </section>
  );
}
