// EnrollmentLogTable.tsx — the enrollment log (contact · status · step · last event · send action). Status
// renders via the slice tone maps ("neutral" → plain grey pill, no dot); terminal entries get no send
// action. Send failures render verbatim under their row — "suppressed" quietly, the CAN-SPAM 422 as an error.
"use client";

import { StatusBadge } from "@leadwolf/ui";
import { Fragment } from "react";
import type { SendFailure } from "../hooks/useEnrollment";
import styles from "../sequences.module.css";
import {
  ENROLLMENT_STATUS_LABEL,
  ENROLLMENT_STATUS_TONE,
  type EnrollmentEntry,
  type EnrollmentStatus,
  TERMINAL_ENROLLMENT_STATUSES,
  formatEventDate,
  shortId,
} from "../types";

function EnrollmentBadge({ status }: { status: EnrollmentStatus }) {
  const tone = ENROLLMENT_STATUS_TONE[status];
  const label = ENROLLMENT_STATUS_LABEL[status];
  if (tone === "neutral") return <span className={styles.neutralPill}>{label}</span>;
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

export function EnrollmentLogTable({
  entries,
  sendingId,
  sendFailures,
  onSend,
}: {
  entries: EnrollmentEntry[];
  sendingId: string | null;
  sendFailures: Record<string, SendFailure>;
  onSend: (logId: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <p className={styles.muted}>
        No contacts enrolled yet. Pick a revealed contact above to start the journey.
      </p>
    );
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Contact</th>
            <th>Status</th>
            <th>Step</th>
            <th>Last event</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const failure = sendFailures[entry.id];
            const sending = sendingId === entry.id;
            return (
              <Fragment key={entry.id}>
                <tr className={failure ? styles.rowWithNote : undefined}>
                  <td className={styles.mono}>{shortId(entry.contactId)}</td>
                  <td>
                    <EnrollmentBadge status={entry.status} />
                  </td>
                  <td className={styles.stepCell}>{entry.currentStep}</td>
                  <td>{formatEventDate(entry.lastEventAt)}</td>
                  <td className={styles.actionCell}>
                    {!TERMINAL_ENROLLMENT_STATUSES.has(entry.status) && (
                      <button
                        type="button"
                        className={styles.smallButton}
                        disabled={sendingId !== null}
                        onClick={() => onSend(entry.id)}
                      >
                        {sending ? "Sending…" : "Send next step"}
                      </button>
                    )}
                  </td>
                </tr>
                {failure && (
                  <tr className={styles.noteRow}>
                    <td colSpan={5}>
                      <p
                        className={
                          failure.code === "suppressed" ? styles.quietFailure : styles.error
                        }
                      >
                        {failure.message}
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
