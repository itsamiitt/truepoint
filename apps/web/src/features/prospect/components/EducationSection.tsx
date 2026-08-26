// EducationSection.tsx — where this person studied (0108), the sibling of the employment history the
// contact record already shows.
//
// The two person→organization edges are rendered as different things because they ARE different things:
// employment carries title and seniority, education carries degree, field and dates. The alumnus/current
// distinction arrives pre-derived from the API (`completed`), so this component never re-implements the
// date rule — there is exactly one place that decides it, and it is not the UI.
"use client";

import { EmptyState, StateSwitch } from "@leadwolf/ui";
import { GraduationCap } from "lucide-react";
import { useContactEducation } from "../hooks/useContactEducation";
import styles from "../prospect.module.css";

/** "2015 – 2019", "2015 – present", or "" when the source gave no usable dates. */
function years(startedOn: string | null, endedOn: string | null): string {
  const start = startedOn ? startedOn.slice(0, 4) : null;
  const end = endedOn ? endedOn.slice(0, 4) : null;
  if (!start && !end) return "";
  if (start && end) return `${start} – ${end}`;
  if (start) return `${start} – present`;
  return `until ${end}`;
}

export function EducationSection({ contactId }: { contactId: string }) {
  const { education, resolved, loading, error, reload } = useContactEducation(contactId);

  return (
    <StateSwitch
      loading={loading}
      error={error}
      empty={!loading && education.length === 0}
      onRetry={reload}
      emptyState={
        <EmptyState
          icon={<GraduationCap size={24} />}
          title={resolved ? "No education on record" : "Not matched to the graph yet"}
          // The two empty states are genuinely different facts and must not share copy: one means "we
          // looked and hold nothing", the other means "we have not identified this person yet", and
          // collapsing them would assert the first when only the second is true.
          description={
            resolved
              ? "We hold no education history for this person."
              : "Education appears once this contact is matched to the shared graph."
          }
        />
      }
    >
      <ul className={styles.timeline}>
        {education.map((row) => {
          const span = years(row.started_on, row.ended_on);
          return (
            <li key={row.id} className={styles.timelineItem}>
              <div className={styles.timelineMeta}>
                <div className={styles.fieldValue}>
                  {row.school_name ?? "Unknown institution"}
                  {!row.resolved ? (
                    // The institution string is what the source said; ER has not matched it to a node yet.
                    <span className={styles.fieldLabel}> · unverified</span>
                  ) : null}
                </div>
                <div className={styles.fieldLabel}>
                  {[row.degree, row.fields_of_study.join(", "), span].filter(Boolean).join(" · ")}
                  {row.completed ? "" : " · current"}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </StateSwitch>
  );
}
