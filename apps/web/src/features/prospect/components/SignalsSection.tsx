// SignalsSection.tsx — what we have actually observed about this contact (plan 33 · Track C).
//
// Reads the TENANT-private signal store, so unlike its neighbours in this drawer it crosses no wall and has
// real data today: the S-13 job-change sweep writes job_change rows.
//
// ⚠ WHY THERE IS NO CATEGORY LIST HERE. The signal_type vocabulary admits nine values, but only job_change
// has a producer — tech_install and funding_round have consumers and no writer, the web/content/keyword
// family is a deferred non-goal, and the LinkedIn-derived pair is forbidden outright. Rendering nine
// categories (eight of them permanently empty) would advertise coverage the product cannot deliver, so this
// lists the signals that exist and nothing more.
"use client";

import type { ContactSignalsResponse } from "@leadwolf/types";
import { EmptyState, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { useQuery } from "@tanstack/react-query";
import { Radar } from "lucide-react";
import { fetchContactSignals } from "../accountIntelligenceApi";
import { prospectKeys } from "../keys";
import styles from "../prospect.module.css";

/** Copy for the types that can actually appear. Unknown types fall through to a humanized token rather than
 *  being dropped — a signal we cannot name is still a signal, and hiding it would be a silent data loss. */
const SIGNAL_LABELS: Record<string, string> = {
  job_change: "Changed jobs",
  new_hire: "New hire",
  funding_round: "Funding round",
  tech_install: "Technology installed",
};

/** A job change is the one signal that should visibly demand attention — it invalidates the record. */
function signalTone(type: string): "warning" | "muted" {
  return type === "job_change" ? "warning" : "muted";
}

function label(type: string): string {
  return SIGNAL_LABELS[type] ?? type.replace(/_/g, " ");
}

export function SignalsSection({ contactId }: { contactId: string }) {
  const query = useQuery<ContactSignalsResponse>({
    queryKey: prospectKeys.contactSignals(contactId),
    queryFn: () => fetchContactSignals(contactId),
  });

  const signals = query.data?.signals ?? [];

  return (
    <StateSwitch
      loading={query.isPending}
      error={
        query.error
          ? query.error instanceof Error
            ? query.error.message
            : "Could not load signals"
          : null
      }
      empty={!query.isPending && signals.length === 0}
      onRetry={() => void query.refetch()}
      emptyState={
        <EmptyState
          icon={<Radar size={24} />}
          title="No signals yet"
          description="Job changes and other observed events will appear here."
        />
      }
    >
      <ul className={styles.timeline}>
        {signals.map((s) => (
          <li key={`${s.signal_type}-${String(s.detected_at)}`} className={styles.timelineItem}>
            <div className={styles.timelineMeta}>
              <div className={styles.fieldValue}>
                <StatusBadge tone={signalTone(s.signal_type)}>{label(s.signal_type)}</StatusBadge>
              </div>
              <div className={styles.fieldLabel}>
                {new Date(s.detected_at).toLocaleDateString()}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </StateSwitch>
  );
}
