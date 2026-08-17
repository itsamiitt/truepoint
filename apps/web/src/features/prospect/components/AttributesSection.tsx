// AttributesSection.tsx — skills + languages from the graph (0116; linkedin-source-ingestion §customer UI).
//
// Chips, not a table: skills are unordered labels (LinkedIn's ordering is presentation, not fact — the
// mapper deliberately drops it), and a chip row degrades gracefully from 2 skills to 60. Languages render
// name + proficiency when the source asserted one. The whole section self-hides into an EmptyState until
// the linkedin_api landing populates the tables — the EmploymentSection "grows into detail" posture.
"use client";

import { EmptyState, StateSwitch, TpChip } from "@leadwolf/ui";
import { Sparkles } from "lucide-react";
import { useContactAttributes } from "../hooks/useContactAttributes";
import styles from "../prospect.module.css";

const PROFICIENCY_LABELS: Record<string, string> = {
  ELEMENTARY: "elementary",
  LIMITED_WORKING: "limited working",
  PROFESSIONAL_WORKING: "professional",
  FULL_PROFESSIONAL: "full professional",
  NATIVE_OR_BILINGUAL: "native",
};

export function AttributesSection({ contactId }: { contactId: string }) {
  const { skills, languages, resolved, loading, error, reload } = useContactAttributes(contactId);
  const empty = !loading && skills.length === 0 && languages.length === 0;

  return (
    <StateSwitch
      loading={loading}
      error={error}
      empty={empty}
      onRetry={reload}
      emptyState={
        <EmptyState
          icon={<Sparkles size={24} />}
          title={resolved ? "No skills on record" : "Not matched to the graph yet"}
          description={
            resolved
              ? "Skills and languages appear after a LinkedIn refresh."
              : "Attributes appear once this contact is matched to the shared graph."
          }
        />
      }
    >
      {skills.length > 0 ? (
        <div className={styles.attributeGroup}>
          <div className={styles.fieldLabel}>Skills</div>
          <div className={styles.chipRow}>
            {skills.map((s) => (
              <TpChip key={s.skill}>{s.skill}</TpChip>
            ))}
          </div>
        </div>
      ) : null}
      {languages.length > 0 ? (
        <div className={styles.attributeGroup}>
          <div className={styles.fieldLabel}>Languages</div>
          <div className={styles.chipRow}>
            {languages.map((l) => (
              <TpChip key={l.name}>
                {l.name}
                {l.proficiency
                  ? ` · ${PROFICIENCY_LABELS[l.proficiency] ?? l.proficiency.toLowerCase()}`
                  : ""}
              </TpChip>
            ))}
          </div>
        </div>
      ) : null}
    </StateSwitch>
  );
}
