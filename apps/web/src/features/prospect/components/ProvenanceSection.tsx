// ProvenanceSection.tsx — "why do we believe this?", answered on a record you already own (plan 33 · A1).
//
// The confidence model has shipped for a while but surfaced ONLY inside RevealDialog, so a customer saw the
// evidence at the instant they spent a credit and never again. This is the same badge, free, on the record.
//
// THREE RULES THIS COMPONENT ENFORCES, all of them about not overclaiming:
//   1. Band, never the decimal. "high" invites a judgement; "0.87" invites an argument about the third
//      significant figure of a number we cannot defend to that precision.
//   2. Recency is ALWAYS shown beside the band. A confident-looking badge on a two-year-old observation is
//      the failure mode that generates support tickets — the age is what makes the band honest.
//   3. Absent evidence renders as absent. A record with no events shows "not recorded", never "0 sources",
//      because a zero reads as a verdict on the data when it is really an absence of log.
"use client";

import type { FieldProvenanceDto } from "@leadwolf/types";
import { EmptyState, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { ShieldCheck } from "lucide-react";
import { useContactProvenance } from "../hooks/useContactProvenance";
import styles from "../prospect.module.css";

/** Bands map to the shared status tones — semantic colour, never the brand accent. */
function bandTone(band: string): "success" | "warning" | "danger" | "muted" {
  if (band === "high") return "success";
  if (band === "medium") return "warning";
  if (band === "low") return "danger";
  return "muted"; // unverified
}

function ageLabel(ageDays: number | null): string {
  if (ageDays === null) return "never verified";
  if (ageDays <= 0) return "verified today";
  if (ageDays === 1) return "verified yesterday";
  if (ageDays < 30) return `verified ${ageDays}d ago`;
  if (ageDays < 365) return `verified ${Math.round(ageDays / 30)}mo ago`;
  return `verified ${Math.floor(ageDays / 365)}y ago`;
}

const FIELD_LABELS: Record<string, string> = { email: "Email", phone: "Phone" };

function ProvenanceRow({ row }: { row: FieldProvenanceDto }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{FIELD_LABELS[row.field] ?? row.field}</span>
      <div className={styles.revealedValueRow}>
        <StatusBadge tone={bandTone(row.band)}>{row.band}</StatusBadge>
        {/* Recency sits beside the band by design — see rule 2 in the header. */}
        <span className={styles.fieldLabel}>
          {ageLabel(row.age_days)} · {row.source_count}{" "}
          {row.source_count === 1 ? "source" : "sources"}
          {row.strongest_method ? ` · ${row.strongest_method.replace(/_/g, " ")}` : ""}
        </span>
      </div>
    </div>
  );
}

export function ProvenanceSection({ contactId }: { contactId: string }) {
  const { fields, resolved, loading, error, reload } = useContactProvenance(contactId);

  return (
    <StateSwitch
      loading={loading}
      error={error}
      empty={!loading && fields.length === 0}
      onRetry={reload}
      emptyState={
        <EmptyState
          icon={<ShieldCheck size={24} />}
          title={resolved ? "No evidence recorded yet" : "Not matched to the graph yet"}
          description={
            resolved
              ? "Nothing has vouched for these fields yet. Verification and enrichment fill this in."
              : "Provenance appears once this contact is matched to the shared graph."
          }
        />
      }
    >
      <div className={styles.fieldGrid}>
        {fields.map((row) => (
          <ProvenanceRow key={row.field} row={row} />
        ))}
      </div>
    </StateSwitch>
  );
}
