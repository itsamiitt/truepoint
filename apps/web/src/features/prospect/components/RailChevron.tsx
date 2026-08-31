// RailChevron.tsx — the one disclosure chevron every rail row shares (Search v4): a ▾ that rotates open
// via CSS on the ancestor's [aria-expanded]. Decorative — the toggle button carries the semantics.
"use client";

import styles from "../prospect.module.css";

export function RailChevron() {
  return (
    <svg
      className={styles.railChev}
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
