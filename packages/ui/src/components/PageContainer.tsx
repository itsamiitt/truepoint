// PageContainer.tsx — the one page container every surface in every app sits in, the layout peer of
// PageHeader. It replaces the per-feature `.page` class that each surface had invented for itself: ten
// different max-widths across apps/web, apps/admin, apps/forge and apps/auth, and fifteen of eighteen of
// them setting a max-width with NO horizontal auto-margin — which is why content pinned flush-left and left
// a dead gutter on any wide display.
//
// Centering is not a choice here. Every width centers; only the cap differs, so a page cannot opt into the
// bug again. Pick the cap by what the page holds, not by how wide it happens to look today:
//   fluid   — no cap. Tables, lists, search: they should use the whole content column.
//   default — 1280px. Dashboards, reports, mixed content.
//   narrow  — 880px. Forms, settings, detail: long measures hurt readability.
//
// Styling lives in primitives.css (.tp-ui-page-container) rather than inline because the padding is
// responsive, and a style prop cannot express a media query — the same reason PageHeader gives.
import type { ReactNode } from "react";

export type PageWidth = "fluid" | "default" | "narrow";

export function PageContainer({
  width = "default",
  className,
  children,
}: {
  /** Width cap. Defaults to "default" (1280px). Use "fluid" for tables/lists, "narrow" for forms. */
  width?: PageWidth;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={className ? `tp-ui-page-container ${className}` : "tp-ui-page-container"}
      data-width={width}
    >
      {children}
    </div>
  );
}
