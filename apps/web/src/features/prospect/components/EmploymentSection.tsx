// EmploymentSection.tsx — career history from the graph (plan 33 · A2).
//
// ⚠ THIS COMPONENT IS DELIBERATELY NOT A TIMELINE, and that is the whole design decision.
//
// The live import path mints a BARE employment edge: person, company, is_current, is_primary — no title, no
// start date, no end date. A timeline laid out for rich stints would render a column of dashes against every
// row, which reads as "broken" rather than "sparse", and would quietly train users to distrust the section.
//
// So: a company list that GROWS INTO detail. Each row shows whatever it actually has — company always, then
// title, then dates — and a stint that carries the full payload (once enrichment fills it) renders richer
// automatically with no code change. Nothing here is laid out for data we do not have.
"use client";

import type { EmploymentStintDto } from "@leadwolf/types";
import { EmptyState, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { Briefcase } from "lucide-react";
import { useContactEmployment } from "../hooks/useContactEmployment";
import styles from "../prospect.module.css";

/** "2019 – 2023", "2019 – present", or "" when the source gave no usable dates (the common case today). */
function span(startedOn: string | null, endedOn: string | null, isCurrent: boolean): string {
  const start = startedOn ? startedOn.slice(0, 4) : null;
  const end = endedOn ? endedOn.slice(0, 4) : null;
  if (!start && !end) return "";
  if (start && end) return `${start} – ${end}`;
  if (start) return isCurrent ? `${start} – present` : `${start} –`;
  return `until ${end}`;
}

function StintRow({ stint }: { stint: EmploymentStintDto }) {
  // Built from whatever exists rather than a fixed template, so a bare edge shows a clean single line
  // instead of a row of em-dashes.
  const detail = [
    stint.title,
    stint.department,
    span(stint.started_on, stint.ended_on, stint.is_current),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className={styles.timelineItem}>
      <div className={styles.timelineMeta}>
        <div className={styles.fieldValue}>
          {stint.company_name ?? "Unknown employer"}
          {stint.is_current ? <StatusBadge tone="success">current</StatusBadge> : null}
        </div>
        {detail ? <div className={styles.fieldLabel}>{detail}</div> : null}
      </div>
    </li>
  );
}

export function EmploymentSection({ contactId }: { contactId: string }) {
  const { stints, resolved, loading, error, reload } = useContactEmployment(contactId);

  return (
    <StateSwitch
      loading={loading}
      error={error}
      empty={!loading && stints.length === 0}
      onRetry={reload}
      emptyState={
        <EmptyState
          icon={<Briefcase size={24} />}
          title={resolved ? "No employment on record" : "Not matched to the graph yet"}
          description={
            resolved
              ? "We hold no career history for this person."
              : "Employment appears once this contact is matched to the shared graph."
          }
        />
      }
    >
      <ul className={styles.timeline}>
        {stints.map((stint, i) => (
          <StintRow
            // No stable id on the wire (the edge id is a Layer-0 identifier we deliberately do not ship),
            // so the key is company + index — stable for a list that is read-only and never reordered.
            key={`${stint.company_name ?? "unknown"}-${i}`}
            stint={stint}
          />
        ))}
      </ul>
    </StateSwitch>
  );
}
