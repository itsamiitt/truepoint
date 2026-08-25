// QuickViewDrawer.tsx — a LIGHTWEIGHT record preview (24, 04 §6): avatar + name + title + company + email
// status + a few masked facets, with an "Open full record" button that hands off to the heavy RecordDetail.
// Deliberately read-only — no reveal/edit/score/timeline machinery (that all lives in RecordDetail). Reuses the
// foundation Drawer + the masked-view presentation helpers; the page owns selection (a null contact = closed).
"use client";

import type { MaskedContact } from "@leadwolf/types";
import { Avatar, Drawer, StatusBadge, TpButton } from "@leadwolf/ui";
import { ExternalLink } from "lucide-react";
import styles from "../prospect.module.css";
import {
  EMAIL_STATUS_LABELS,
  OUTREACH_STATUS_LABELS,
  SENIORITY_LABELS,
  companyLabel,
  dataHealthTone,
  displayName,
  maskedEmail,
  phoneLineTypeLabel,
  shortDate,
} from "../types";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue}>{value}</span>
    </div>
  );
}

export function QuickViewDrawer({
  contact,
  onClose,
  onOpenFull,
}: {
  /** The previewed row; null closes the Drawer. */
  contact: MaskedContact | null;
  onClose: () => void;
  /** Hand off to the full RecordDetail. Omit to hide the button. */
  onOpenFull?: () => void;
}) {
  const open = contact != null;
  const location = contact
    ? [contact.locationCity, contact.locationCountry].filter(Boolean).join(", ") || "—"
    : "—";

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={contact ? displayName(contact) : "Preview"}
      width={400}
      footer={
        contact && onOpenFull ? (
          <div className={styles.drawerActions}>
            <TpButton
              variant="primary"
              size="sm"
              leftIcon={<ExternalLink size={15} />}
              onClick={onOpenFull}
            >
              Open full record
            </TpButton>
          </div>
        ) : undefined
      }
    >
      {contact ? (
        <div className={styles.detail}>
          <div className={styles.identity}>
            <Avatar name={displayName(contact)} size={44} />
            <div className={styles.identityMeta}>
              <span className={styles.identityName}>{displayName(contact)}</span>
              <span className={styles.identitySub}>{contact.jobTitle ?? "—"}</span>
            </div>
          </div>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Overview</h3>
              <StatusBadge tone={dataHealthTone(contact)}>
                {contact.hasEmail ? EMAIL_STATUS_LABELS[contact.emailStatus] : "No email"}
              </StatusBadge>
            </div>
            <div className={styles.fieldGrid}>
              {/* Company was showing the email DOMAIN under a "Company" label while the grid row beside it
                  showed the account NAME — the same record reading two different ways. One helper now
                  answers it for both, and the domain gets its own labelled field. */}
              <Field label="Company" value={companyLabel(contact) ?? "—"} />
              <Field label="Domain" value={contact.emailDomain ?? "—"} />
              <Field
                label="Seniority"
                value={contact.seniorityLevel ? SENIORITY_LABELS[contact.seniorityLevel] : "—"}
              />
              <Field label="Department" value={contact.department ?? "—"} />
              <Field label="Location" value={location} />
              <Field label="Outreach" value={OUTREACH_STATUS_LABELS[contact.outreachStatus]} />
              <Field label="Email" value={maskedEmail(contact)} />
              <Field
                label="Phone"
                value={
                  contact.hasPhone
                    ? [
                        "Locked — reveal",
                        phoneLineTypeLabel(contact.phoneLineType ?? null) ?? undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "—"
                }
              />
              {/* [S-10]: when the record was last verified is the judgement the preview exists to support. */}
              <Field label="Last verified" value={shortDate(contact.lastVerifiedAt)} />
              <Field label="Added" value={shortDate(contact.createdAt)} />
            </div>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
