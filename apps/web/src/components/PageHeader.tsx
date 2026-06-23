// PageHeader.tsx — the one shared destination header for every (shell) surface. It collapses the two
// header patterns that had been copy-pasted across features into a single component:
//   • cockpit  — a mono eyebrow + a large 28px title (pass `eyebrow`; used by Home)
//   • destination — a 22px title, no eyebrow (Sequences, Enrichment, Inbox, Reports, Sales Nav, Import)
// Hierarchy is weight + size only; color comes from --tp-* tokens. The optional `actions` slot sits on the
// right (callers pass their own TpButton). Layout/rhythm live in PageHeader.module.css; this is app chrome,
// so it lives in apps/web (not @leadwolf/ui, which apps/admin also consumes).
import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

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
  /** Right-aligned actions (e.g. a Refresh TpButton). */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={className ? `${styles.header} ${className}` : styles.header}
      data-variant={eyebrow ? "cockpit" : "destination"}
    >
      <div className={styles.text}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h1 className={styles.title}>{title}</h1>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
