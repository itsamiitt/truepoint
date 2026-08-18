// AuthShell.tsx — the centered card layout every auth screen uses. Presentation only (no logic/fetch);
// mobile-first, light, hairline border, one soft shadow. Accessible: the card is labelled by its title.
//
// The centering comes from .tp-center-screen in @leadwolf/app-shell's shell.css — the same class the three
// consoles use for their gate/boot screens — so the auth origin inherits its 100vh -> 100dvh fallback pair.
// The previous `min-h-screen` was plain 100vh, which sits under mobile browser chrome and pushed the card
// off-centre on phones. Everything else is token-driven inline style: no Tailwind utilities in app JSX.
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
    <main className="tp-center-screen">
      <section
        aria-labelledby="auth-title"
        className="tp-card-enter"
        style={{
          width: "100%",
          maxWidth: 400,
          padding: "28px var(--tp-space-6)",
          background: "var(--tp-surface)",
          border: "1px solid var(--tp-hairline-2)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--tp-shadow-card-hover)",
        }}
      >
        <BrandLockup />
        <h1
          id="auth-title"
          style={{
            margin: "0 0 var(--tp-space-1)",
            fontSize: 22,
            fontWeight: 600,
            lineHeight: 1.2,
          }}
        >
          {title}
        </h1>
        {subtitle ? (
          <p
            style={{
              margin: "0 0 var(--tp-space-5)",
              fontSize: 14,
              color: "var(--tp-ink-3)",
            }}
          >
            {subtitle}
          </p>
        ) : null}
        {children}
        {footer ? (
          <div style={{ marginTop: "var(--tp-space-4)", fontSize: 13, color: "var(--tp-ink-3)" }}>
            {footer}
          </div>
        ) : null}
      </section>
    </main>
  );
}
