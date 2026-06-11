// EnrollmentPanel.tsx — the selected sequence's detail card: an "Enroll a contact" picker (revealed
// contacts only) above the enrollment log table with its per-entry send action. Branches on the RFC-9457
// code — "suppressed" (403) becomes a quiet DNC notice, never a red error. View state via useEnrollment.
"use client";

import { Spinner } from "@leadwolf/ui";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useEnrollableContacts } from "../hooks/useEnrollableContacts";
import { useEnrollment } from "../hooks/useEnrollment";
import styles from "../sequences.module.css";
import { type SequenceSummary, contactOptionLabel } from "../types";
import { EnrollmentLogTable } from "./EnrollmentLogTable";

export function EnrollmentPanel({
  sequence,
  onChanged,
}: {
  sequence: SequenceSummary;
  onChanged: () => void;
}) {
  const contacts = useEnrollableContacts();
  const log = useEnrollment(sequence.id, onChanged);
  const [contactId, setContactId] = useState("");

  async function onEnroll(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!contactId || log.enrolling) return;
    const ok = await log.enroll(contactId);
    if (ok) setContactId("");
  }

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Enrollment</h2>
        <p className={styles.cardHint}>
          {sequence.name} · {sequence.enrolledCount} enrolled
        </p>
      </div>

      <form className={styles.form} onSubmit={(e) => void onEnroll(e)}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>Enroll a contact</span>
            <select
              className={styles.select}
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              disabled={contacts.loading || contacts.enrollable.length === 0}
            >
              <option value="">
                {contacts.loading ? "Loading contacts…" : "Choose a revealed contact…"}
              </option>
              {contacts.enrollable.map((c) => (
                <option key={c.id} value={c.id}>
                  {contactOptionLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <div className={`${styles.actions} ${styles.rowEnd}`}>
            <button className={styles.button} type="submit" disabled={!contactId || log.enrolling}>
              {log.enrolling ? "Enrolling…" : "Enroll"}
            </button>
          </div>
        </div>

        <p className={styles.hint}>
          <span className={styles.hintDot} aria-hidden="true" />
          <span>
            Only revealed contacts can be enrolled; suppressed contacts are blocked at the send
            gate.
          </span>
        </p>

        {!contacts.loading && contacts.enrollable.length === 0 && !contacts.error && (
          <p className={styles.muted}>
            No revealed contacts yet — reveal one in{" "}
            <Link className={styles.inlineLink} href="/prospect">
              Prospect
            </Link>{" "}
            first.
          </p>
        )}
        {contacts.error && <p className={styles.error}>{contacts.error}</p>}

        {log.enrolledNotice && (
          <p className={styles.success}>
            <span className={styles.successDot} aria-hidden="true" />
            <span>{log.enrolledNotice}</span>
          </p>
        )}
        {log.dncNotice && (
          <p className={styles.dncNotice}>
            <span className={styles.dncDot} aria-hidden="true" />
            <span>On the do-not-contact list — {log.dncNotice}</span>
          </p>
        )}
        {log.enrollError && <p className={styles.error}>{log.enrollError}</p>}
      </form>

      <hr className={styles.panelDivider} />

      {log.error && <p className={styles.error}>{log.error}</p>}
      {log.loading ? (
        <div className={styles.loadingRow}>
          <Spinner /> Loading the enrollment log…
        </div>
      ) : (
        <EnrollmentLogTable
          entries={log.entries}
          sendingId={log.sendingId}
          sendFailures={log.sendFailures}
          onSend={(id) => void log.sendNext(id)}
        />
      )}
    </section>
  );
}
