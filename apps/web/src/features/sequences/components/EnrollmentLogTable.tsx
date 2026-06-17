// EnrollmentLogTable.tsx — the enrollment log on the shared DataTable (contact · status · step · last event ·
// send action). Status renders via the slice tone maps ("neutral" → plain grey pill, no dot); terminal
// entries get no send action. A failed send surfaces verbatim beneath its row — "suppressed" quietly, the
// CAN-SPAM 422 as an error. Empty body is the State Kit's EmptyState. Pure presentation.
"use client";

import { type Column, DataTable, EmptyState, Icon, StatusBadge, TpButton } from "@leadwolf/ui";
import { Inbox, Send } from "lucide-react";
import type { SendFailure } from "../hooks/useEnrollment";
import styles from "../sequences.module.css";
import {
  ENROLLMENT_STATUS_LABEL,
  ENROLLMENT_STATUS_TONE,
  type EnrollmentEntry,
  type EnrollmentStatus,
  formatEventDate,
  shortId,
  TERMINAL_ENROLLMENT_STATUSES,
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
  const columns: Column<EnrollmentEntry>[] = [
    {
      key: "contact",
      header: "Contact",
      cell: (e) => <span className={styles.mono}>{shortId(e.contactId)}</span>,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (e) => e.status,
      cell: (e) => <EnrollmentBadge status={e.status} />,
    },
    {
      key: "step",
      header: "Step",
      align: "right",
      sortValue: (e) => e.currentStep,
      cell: (e) => <span className={styles.numCell}>{e.currentStep}</span>,
    },
    {
      key: "lastEvent",
      header: "Last event",
      sortValue: (e) => e.lastEventAt,
      cell: (e) => formatEventDate(e.lastEventAt),
    },
    {
      key: "action",
      header: "",
      align: "right",
      cell: (e) => {
        const failure = sendFailures[e.id];
        const terminal = TERMINAL_ENROLLMENT_STATUSES.has(e.status);
        return (
          <div>
            {!terminal && (
              <TpButton
                variant="secondary"
                size="sm"
                loading={sendingId === e.id}
                disabled={sendingId !== null}
                leftIcon={<Icon icon={Send} size={13} />}
                onClick={() => onSend(e.id)}
              >
                Send next step
              </TpButton>
            )}
            {failure && (
              <p
                className={`${styles.failureNote} ${
                  failure.code === "suppressed" ? styles.failureNoteQuiet : styles.failureNoteError
                }`}
              >
                {failure.message}
              </p>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={entries}
      rowKey={(e) => e.id}
      empty={
        <EmptyState
          icon={<Icon icon={Inbox} size={28} />}
          title="No contacts enrolled yet"
          description="Pick a revealed contact above to start the journey through this sequence."
        />
      }
    />
  );
}
