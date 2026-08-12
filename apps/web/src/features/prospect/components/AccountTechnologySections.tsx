// AccountTechnologySections.tsx — the develops-vs-uses split, rendered.
//
// TWO SECTIONS, NEVER ONE MERGED LIST. "Builds" is the company's own product portfolio (from the Layer-0
// vendor ledger); "Runs" is third-party technology detected in its stack (from the adoption edge). They are
// different facts, so they get different headings, different sub-copy, and different per-row detail —
// merging them would reproduce in the UI exactly the confusion the schema and API were built to prevent.
//
// Each section fetches independently (separate cache entries keyed by relationship), so a slow or empty
// answer on one side never blocks or blanks the other.
"use client";

import type { OrgTechnologyRelationship } from "@leadwolf/types";
import { TpChip } from "@leadwolf/ui";
import { useAccountTechnologies } from "../hooks/useAccountTechnologies";
import styles from "../prospect.module.css";

/** Days since a detection, as a short human phrase. Recency IS the liveness signal for a `uses` row. */
function seenAgo(iso: Date | string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "seen today";
  if (days === 1) return "seen yesterday";
  if (days < 30) return `seen ${days}d ago`;
  const months = Math.round(days / 30);
  return `seen ${months}mo ago`;
}

const COPY: Record<OrgTechnologyRelationship, { title: string; hint: string; empty: string }> = {
  develops: {
    title: "Builds",
    hint: "Products this company makes or owns.",
    empty: "No products recorded for this company.",
  },
  uses: {
    title: "Runs",
    hint: "Third-party technology detected in their stack — never their own products.",
    empty: "No technology detected in their stack.",
  },
};

export function AccountTechnologySection({
  accountId,
  relationship,
}: {
  accountId: string | null;
  relationship: OrgTechnologyRelationship;
}) {
  const { rows, resolved, loading, error } = useAccountTechnologies(accountId, relationship);
  const copy = COPY[relationship];

  // An account with no Layer-0 bridge has no answer either way. Saying "builds nothing" here would be a
  // claim the data does not support, so the unmatched state is stated plainly instead.
  if (!loading && !error && !resolved) return null;

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>{copy.title}</h3>
        {rows.length > 0 ? <span className={styles.fieldLabel}>{rows.length}</span> : null}
      </div>
      <p className={styles.fieldLabel}>{copy.hint}</p>

      {loading ? (
        <p className={styles.fieldLabel}>Loading…</p>
      ) : error ? (
        <p className={styles.fieldLabel}>{error}</p>
      ) : rows.length === 0 ? (
        <p className={styles.fieldLabel}>{copy.empty}</p>
      ) : (
        <div className={styles.chipWrap}>
          {rows.map((row) => (
            <TpChip key={row.technology_id}>
              {row.canonical_name}
              {row.relationship === "uses" ? (
                <span className={styles.fieldLabel}>
                  {" · "}
                  {seenAgo(row.last_seen_at)}
                  {row.creator ? ` · by ${row.creator.name}` : ""}
                </span>
              ) : row.ownership === "creator" ? (
                <span className={styles.fieldLabel}>{" · created"}</span>
              ) : null}
            </TpChip>
          ))}
        </div>
      )}
    </section>
  );
}
