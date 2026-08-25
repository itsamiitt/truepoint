// AccountShell.tsx — the layout for the signed-in /account/security surface. Presentation only (no logic /
// fetch). Wider than AuthShell (this is a settings surface, not a single-purpose auth card), with a labelled
// in-page section nav that deep-link anchors (#password / #mfa / #sessions / #history) target — so the
// apps/web SecurityPanel "Manage on the sign-in site" links land on the right section. WCAG 2.2 AA: the page
// is one labelled <main>, the nav is a labelled landmark, and each section is reachable by keyboard.
//
// Width and gutters come from <PageContainer width="narrow"> — the same container every settings surface in
// apps/web uses. This was previously the only surface in the repo with no shared width or height contract at
// all (a bespoke max-w-[760px]); it now matches, and the styling is token-driven inline rather than Tailwind.
import { Card, PageContainer } from "@leadwolf/ui";
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
    <PageContainer width="narrow">
      <main aria-labelledby="account-title">
        <BrandLockup />
        <header style={{ marginBottom: "var(--tp-space-6)" }}>
          {/* 26px is OFF the --tp-text-* ladder (which tops out at 22 = --tp-text-display) and stays that way
              deliberately: this is the destination-page title of the only settings surface on the auth origin,
              a step above the 22px AuthShell card title so the two read as different kinds of page. Per
              tokens.css, a size off the ladder is a design decision, not a typo — it is not a stray px. */}
          <h1
            id="account-title"
            style={{ margin: 0, fontSize: 26, fontWeight: 600, lineHeight: 1.2 }}
          >
            {title}
          </h1>
          {subtitle ? (
            <p
              style={{
                margin: "var(--tp-space-1) 0 0",
                fontSize: "var(--tp-text-label)",
                color: "var(--tp-ink-3)",
              }}
            >
              {subtitle}
            </p>
          ) : null}
        </header>

        {sections.length > 0 ? (
          <nav aria-label="Account security sections" style={{ marginBottom: "var(--tp-space-8)" }}>
            <ul
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--tp-space-1) var(--tp-space-4)",
                margin: 0,
                padding: 0,
                listStyle: "none",
                fontSize: "var(--tp-text-body)",
              }}
            >
              {sections.map((s) => (
                <li key={s.id}>
                  <a
                    href={`#${s.id}`}
                    style={{
                      color: "var(--tp-ink-3)",
                      textDecoration: "underline",
                      textUnderlineOffset: 2,
                    }}
                  >
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--tp-space-8)" }}>
          {children}
        </div>
      </main>
    </PageContainer>
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
    // The surface (padding / border / --tp-radius-card / --tp-shadow-card) belongs to the DS Card, which is a
    // plain server-safe component — nothing here needs to hand-roll it any more. Card takes only children /
    // style / as, so the deep-link `id` and the aria-labelledby stay on this outer <section>; Card renders the
    // inner box as a <div> rather than nesting a second sectioning element inside a labelled one.
    //
    // The ONE override is the fill. Card defaults to --tp-surface-2, which is exactly this origin's PAGE
    // background (globals.css sets body to --tp-surface-2), so an un-overridden card would be invisible
    // against the page it floats on. White is also what AuthShell's card uses, for the same reason.
    <section id={id} aria-labelledby={headingId} style={{ scrollMarginTop: "var(--tp-space-6)" }}>
      <Card as="div" style={{ background: "var(--tp-surface)" }}>
        {/* 17px is off the --tp-text-* ladder (16 title / 18 heading) and left alone: it is the card-heading
            size this surface shipped with, and moving it is a design decision, not a token cleanup. */}
        <h2 id={headingId} style={{ margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.2 }}>
          {title}
        </h2>
        {description ? (
          <p
            style={{
              margin: "var(--tp-space-1) 0 var(--tp-space-4)",
              fontSize: "var(--tp-text-body)",
              color: "var(--tp-ink-3)",
            }}
          >
            {description}
          </p>
        ) : (
          <div style={{ marginBottom: "var(--tp-space-4)" }} />
        )}
        {children}
      </Card>
    </section>
  );
}
