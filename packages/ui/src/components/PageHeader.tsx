// PageHeader.tsx — the one destination header for every app surface. It collapses the header patterns that
// had been copy-pasted across apps/web features and hand-rolled again in apps/admin and apps/forge:
//   • cockpit  — a mono eyebrow + a large 28px title (pass `eyebrow`; used by Home)
//   • destination — a 22px title, no eyebrow (every other destination)
// Hierarchy is weight + size only; color comes from --tp-* tokens. The optional `actions` slot sits on the
// right (callers pass their own TpButton). Styling lives in primitives.css (.tp-ui-page-header*) rather than
// inline, because the cockpit title is responsive and media queries can't be expressed in a style prop.
import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  className,
}: {
  /** Mono, uppercase section marker. When present, switches to the larger "cockpit" title. */
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned actions (e.g. a Refresh button). */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={className ? `tp-ui-page-header ${className}` : "tp-ui-page-header"}
      data-variant={eyebrow ? "cockpit" : "destination"}
    >
      <div className="tp-ui-page-header-text">
        {eyebrow ? <p className="tp-ui-page-header-eyebrow">{eyebrow}</p> : null}
        <h1 className="tp-ui-page-header-title">{title}</h1>
        {subtitle ? <p className="tp-ui-page-header-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="tp-ui-page-header-actions">{actions}</div> : null}
    </header>
  );
}
