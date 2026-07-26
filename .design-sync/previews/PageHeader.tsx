// PageHeader — the shared surface header used across web, admin and forge. The eyebrow is the switch: with
// one it renders the larger "cockpit" title, without one it's the compact section header.
import { PageHeader, TpButton } from "@leadwolf/ui";

const surface: React.CSSProperties = { padding: 20, background: "var(--tp-surface)" };

/** Cockpit form — mono uppercase eyebrow, large title, and a right-aligned action. */
export const Cockpit = () => (
  <div style={surface}>
    <PageHeader
      eyebrow="Workspace"
      title="Good morning, Amit"
      subtitle="4,812 prospects across 1,284 accounts · 12,480 credits remaining"
      actions={<TpButton variant="secondary">Refresh</TpButton>}
    />
  </div>
);

/** Compact form — no eyebrow, so the title drops to section scale. */
export const Section = () => (
  <div style={surface}>
    <PageHeader
      title="Saved searches"
      subtitle="Segments you and your teammates can re-run at any time"
      actions={<TpButton variant="primary">New search</TpButton>}
    />
  </div>
);

/** Title only — the minimum the component renders. */
export const TitleOnly = () => (
  <div style={surface}>
    <PageHeader title="Pipeline stages" />
  </div>
);
