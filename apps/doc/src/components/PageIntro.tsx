// PageIntro.tsx — the eyebrow / title / lede block every page opens with.
//
// One h1 per page, and it lives here, so the document outline is correct without every route remembering to
// get it right.

import type { ReactNode } from "react";
import styles from "./page-intro.module.css";

export function PageIntro({
  eyebrow,
  title,
  lede,
  badge,
}: {
  eyebrow?: string;
  title: string;
  lede: string;
  /** Optional status or metadata row rendered under the lede — an AvailabilityBadge, usually. */
  badge?: ReactNode;
}) {
  return (
    <div className={styles.intro}>
      {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.lede}>{lede}</p>
      {badge ? <div className={styles.badgeRow}>{badge}</div> : null}
    </div>
  );
}
