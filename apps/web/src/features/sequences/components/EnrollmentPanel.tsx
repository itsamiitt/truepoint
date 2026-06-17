// EnrollmentPanel.tsx — the selected sequence's detail, rendered in a Drawer: an "Enroll a contact" picker
// (revealed contacts only) above the enrollment-log DataTable with its per-entry send action. Branches on the
// RFC-9457 code — "suppressed" (403) becomes a quiet DNC notice, never a red error. Log async chrome renders
// through the State Kit's <StateSwitch>. View state via useEnrollment + useEnrollableContacts.
"use client";

import { Drawer, FieldGroup, Icon, StateSwitch, TpButton, TpSelect } from "@leadwolf/ui";
import { UserPlus } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { useEnrollableContacts } from "../hooks/useEnrollableContacts";
import { useEnrollment } from "../hooks/useEnrollment";
import styles from "../sequences.module.css";
import {
  contactOptionLabel,
  SEQUENCE_STATUS_LABEL,
  type SequenceSummary,
} from "../types";
import { EnrollmentLogTable } from "./EnrollmentLogTable";

export function EnrollmentPanel({
  sequence,
  onClose,
  onChanged,
}: {
  sequence: SequenceSummary;
  onClose: () => void;
  onChanged: () => void;
}) {
  const contacts = useEnrollableContacts();
  const log = useEnrollment(sequence.id, onChanged);
  const [contactId, setContactId] = useState("");

  async function runEnroll(): Promise<void> {
    if (!contactId || log.enrolling) return;
    const ok = await log.enroll(contactId);
    if (ok) setContactId("");
  }

  function onFormSubmit(e: FormEvent): void {
    e.preventDefault();
    void runEnroll();
  }

  const noContacts = !contacts.loading && contacts.enrollable.length === 0 && !contacts.error;

  return (
    <Drawer
      open
      onClose={onClose}
      title={sequence.name}
      width={620}
    >
      <p className={styles.cardHint} style={{ marginBottom: 16 }}>
        {SEQUENCE_STATUS_LABEL[sequence.status]} · {sequence.enrolledCount} enrolled ·{" "}
        {sequence.stepCount} step{sequence.stepCount === 1 ? "" : "s"}
      </p>

      <form className={styles.enrollForm} onSubmit={onFormSubmit}>
        <div className={styles.enrollRow}>
          <FieldGroup className={styles.grow} label="Enroll a contact" htmlFor="enroll-contact">
            <TpSelect
              id="enroll-contact"
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
            </TpSelect>
          </FieldGroup>
          <TpButton
            variant="primary"
            loading={log.enrolling}
            disabled={!contactId}
            leftIcon={<Icon icon={UserPlus} size={14} />}
            onClick={() => void runEnroll()}
          >
            Enroll
          </TpButton>
        </div>

        <p className={styles.hint}>
          <span className={styles.hintDot} aria-hidden="true" />
          <span>
            Only revealed contacts can be enrolled; suppressed contacts are blocked at the send gate.
          </span>
        </p>

        {noContacts && (
          <p className={styles.muted}>
            No revealed contacts yet — reveal one in{" "}
            <Link className={styles.inlineLink} href="/prospect">
              Prospect
            </Link>{" "}
            first.
          </p>
        )}
        {contacts.error && <p className={styles.drawerError}>{contacts.error}</p>}

        {log.enrolledNotice && (
          <p className={styles.notice}>
            <span className={styles.noticeDotSuccess} aria-hidden="true" />
            <span>{log.enrolledNotice}</span>
          </p>
        )}
        {log.dncNotice && (
          <p className={styles.notice}>
            <span className={styles.noticeDotWarning} aria-hidden="true" />
            <span>On the do-not-contact list — {log.dncNotice}</span>
          </p>
        )}
        {log.enrollError && <p className={styles.drawerError}>{log.enrollError}</p>}
      </form>

      <hr className={styles.panelDivider} />

      <StateSwitch loading={log.loading} error={log.error} onRetry={() => void log.reload()}>
        <EnrollmentLogTable
          entries={log.entries}
          sendingId={log.sendingId}
          sendFailures={log.sendFailures}
          onSend={(id) => void log.sendNext(id)}
        />
      </StateSwitch>
    </Drawer>
  );
}
