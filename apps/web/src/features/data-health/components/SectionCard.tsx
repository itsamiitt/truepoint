// SectionCard.tsx — the shared titled surface for the Data Health sections: a @leadwolf/ui Card with a compact
// header (title + optional mono hint), mirroring the Home WidgetCard chrome. Presentation only; each section
// supplies its own StateSwitch-wrapped body as children, so the four async states stay owned by the section.
import { Card } from "@leadwolf/ui";
import type { CSSProperties, ReactNode } from "react";
import styles from "../data-health.module.css";

const SURFACE: CSSProperties = {
  background: "var(--tp-surface)",
  border: "1px solid var(--tp-hairline-2)",
  borderRadius: "var(--tp-radius-card)",
  boxShadow: "var(--tp-shadow-card)",
};

export function SectionCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card style={SURFACE}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {hint != null ? <p className={styles.sectionHint}>{hint}</p> : null}
      </div>
      {children}
    </Card>
  );
}
