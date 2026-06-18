// RecordDetail.tsx — the record detail rebuilt on the foundation Drawer (04 §6, 11 §4.2). Preserves context
// over the grid: identity, the lead-score breakdown (composite + icp/intent/engagement, fetched on open via
// useScores — ADR-0008, distinct from email_status), provenance + a Data-Health StatusBadge, an activity
// timeline that surfaces logged notes (EmptyState if none / not-built), and the actions (Reveal, Add to list,
// Enroll, Export). Every async surface goes through the State Kit; the actual charge/gate run server-side.
"use client";

import type { MaskedContact, OutreachStatus, RevealType } from "@leadwolf/types";
import type {
  CustomFieldValueDto,
  CustomFieldValueInput,
  MaskedContact,
  RevealType,
} from "@leadwolf/types";
import {
  Avatar,
  Drawer,
  EmptyState,
  Progress,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpInput,
  TpSelect,
  TpSwitch,
  useToast,
} from "@leadwolf/ui";
import { Activity, Download, ListPlus, Pencil, Send, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { addContactsToList, enrollContacts } from "../api";
import { exportMaskedCsv } from "../export";
import { useActivities } from "../hooks/useActivities";
import { useCustomFields } from "../hooks/useCustomFields";
import { useScores } from "../hooks/useScores";
import styles from "../prospect.module.css";
import {
  ACTIVITY_TYPE_LABELS,
  EMAIL_STATUS_LABELS,
  SENIORITY_LABELS,
  dataHealthTone,
  displayName,
} from "../types";
import { RevealDialog } from "./RevealDialog";
import { StageSelector } from "./StageSelector";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue}>{value}</span>
    </div>
  );
}

/** The lead-score breakdown: a big composite + a row per sub-score with a thin Progress bar (out of 100). */
function ScoreBreakdown({ contactId }: { contactId: string }) {
  const { scores, error, loading, reload } = useScores(contactId);
  const latest = scores?.[0];

  return (
    <StateSwitch
      loading={loading}
      error={error}
      empty={!loading && !latest}
      onRetry={reload}
      skeleton={<Progress value={0} aria-label="Loading score" />}
      emptyState={
        <EmptyState
          title="Not scored yet"
          description="A score lands after the next scoring run."
        />
      }
    >
      {latest ? (
        <div className={styles.scoreGrid}>
          <div className={styles.scoreComposite}>
            <span className={styles.scoreBig}>{latest.compositeScore}</span>
            <span className={styles.scoreCompositeLabel}>Composite</span>
          </div>
          <div className={styles.scoreParts}>
            {(
              [
                ["ICP fit", latest.icpFit],
                ["Intent", latest.intentScore],
                ["Engagement", latest.engagementScore],
              ] as const
            ).map(([label, value]) => (
              <div className={styles.scorePart} key={label}>
                <div className={styles.scorePartHead}>
                  <span className={styles.scorePartLabel}>{label}</span>
                  <span className={styles.scorePartValue}>{value}</span>
                </div>
                <Progress value={value} max={100} label={`${label} ${value}`} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </StateSwitch>
  );
}

/** The activity timeline — EmptyState when there's nothing, or when the M8 backend isn't built (available:false). */
function ActivityTimeline({ contactId }: { contactId: string }) {
  const { feed, error, loading, reload } = useActivities(contactId);
  const rows = feed?.activities ?? [];

  return (
    <StateSwitch
      loading={loading}
      error={error}
      empty={!loading && rows.length === 0}
      onRetry={reload}
      emptyState={
        <EmptyState
          icon={<Activity size={24} />}
          title={feed?.available ? "No activity yet" : "Timeline not connected"}
          description={
            feed?.available
              ? "Sends, opens, replies and calls will appear here."
              : "Activity history ships with the outreach engine (M8)."
          }
        />
      }
    >
      <ul className={styles.timeline}>
        {rows.map((a) => (
          <li className={styles.timelineItem} key={a.id}>
            <span className={styles.timelineDot} aria-hidden />
            <div className={styles.timelineMeta}>
              <span className={styles.timelineType}>
                {ACTIVITY_TYPE_LABELS[a.activityType] ?? a.activityType.replace(/_/g, " ")}
              </span>
              {a.note ? <span className={styles.timelineNote}>{a.note}</span> : null}
              <span className={styles.timelineTime}>{new Date(a.occurredAt).toLocaleString()}</span>
            </div>
          </li>
        ))}
      </ul>
    </StateSwitch>
  );
}

/** Render one custom-field value read-only (date/url/boolean/select/number/text all stringify sensibly). */
function displayValue(v: CustomFieldValueDto): string {
  if (v.value === null || v.value === "") return "—";
  if (v.fieldType === "boolean") return v.value ? "Yes" : "No";
  return String(v.value);
}

/**
 * Custom fields (ADR-0028): a record's workspace-defined values, read inline. A minimal inline edit toggles a
 * per-type control (text/number/date/url input, boolean switch, select dropdown) and saves the shallow-merge
 * via useCustomFields.save — type validation runs server-side. Self-contained; not built (M8) → EmptyState.
 */
function CustomFieldsSection({ contactId }: { contactId: string }) {
  const toast = useToast();
  const { feed, error, loading, saving, reload, save } = useCustomFields(contactId);
  const values = feed?.values ?? [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, CustomFieldValueInput>>({});

  // Seed the draft from the loaded values whenever we enter edit mode / the values change.
  useEffect(() => {
    if (editing) {
      setDraft(Object.fromEntries((feed?.values ?? []).map((v) => [v.key, v.value])));
    }
  }, [editing, feed?.values]);

  const onSave = async () => {
    try {
      const ok = await save(draft);
      if (ok) {
        toast.success("Custom fields saved");
        setEditing(false);
      } else {
        toast.toast({
          title: "Not available yet",
          description: "Custom fields persist once the API ships.",
        });
      }
    } catch (e) {
      toast.error("Could not save", e instanceof Error ? e.message : undefined);
    }
  };

  const setDraftValue = (key: string, value: CustomFieldValueInput) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <StateSwitch
      loading={loading}
      error={error}
      empty={!loading && values.length === 0}
      onRetry={reload}
      emptyState={
        <EmptyState
          title={feed?.available ? "No custom fields" : "Custom fields not connected"}
          description={
            feed?.available
              ? "Define fields in Settings ▸ Workspace ▸ Custom fields."
              : "Custom fields ship with the record-customization layer (M8)."
          }
        />
      }
    >
      {editing ? (
        <div className={styles.fieldGrid}>
          {values.map((v) => (
            <div className={styles.field} key={v.key}>
              <span className={styles.fieldLabel}>{v.label}</span>
              <CustomFieldInput
                field={v}
                value={draft[v.key] ?? null}
                onChange={(val) => setDraftValue(v.key, val)}
              />
            </div>
          ))}
          <div className={styles.drawerActions}>
            <TpButton variant="primary" size="sm" loading={saving} onClick={onSave}>
              Save
            </TpButton>
            <TpButton variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </TpButton>
          </div>
        </div>
      ) : (
        <>
          <div className={styles.fieldGrid}>
            {values.map((v) => (
              <Field key={v.key} label={v.label} value={displayValue(v)} />
            ))}
          </div>
          <div className={styles.drawerActions}>
            <TpButton
              variant="ghost"
              size="sm"
              leftIcon={<Pencil size={14} />}
              onClick={() => setEditing(true)}
            >
              Edit fields
            </TpButton>
          </div>
        </>
      )}
    </StateSwitch>
  );
}

/** A single per-type custom-field edit control (used inside the inline editor). */
function CustomFieldInput({
  field,
  value,
  onChange,
}: {
  field: CustomFieldValueDto;
  value: CustomFieldValueInput;
  onChange: (value: CustomFieldValueInput) => void;
}) {
  const id = `cf-edit-${field.key}`;
  switch (field.fieldType) {
    case "boolean":
      return (
        <TpSwitch id={id} checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      );
    case "select":
      return (
        <TpSelect
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">—</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </TpSelect>
      );
    case "number":
      return (
        <TpInput
          id={id}
          type="number"
          value={value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "date":
      return (
        <TpInput
          id={id}
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    default:
      return (
        <TpInput
          id={id}
          value={typeof value === "string" ? value : value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
  }
}

export function RecordDetail({
  contact,
  onClose,
  onRevealed,
}: {
  /** The selected row; null closes the Drawer. */
  contact: MaskedContact | null;
  onClose: () => void;
  onRevealed: (contactId: string) => void;
}) {
  const toast = useToast();
  const [revealType, setRevealType] = useState<RevealType | null>(null);
  // Live override of the contact's outreach_status after a stage assignment rolls it up server-side, so the
  // Identity field reflects the new status without re-fetching the masked list. Keyed to the contact id so it
  // applies ONLY to the contact it was set for — switching records (A→B) ignores A's override with no flash.
  const [statusOverride, setStatusOverride] = useState<{
    id: string;
    status: OutreachStatus;
  } | null>(null);

  const open = contact != null;
  const outreachStatus =
    (statusOverride?.id === contact?.id ? statusOverride?.status : undefined) ??
    contact?.outreachStatus ??
    "new";
  // While the reveal Dialog is open it owns Esc/backdrop; swallow the Drawer's own close so one Esc doesn't
  // collapse both layers (the foundation Drawer + Dialog both bind a window Esc handler).
  const closeDrawer = () => {
    if (revealType === null) onClose();
  };

  const notWired = (what: string) =>
    toast.toast({
      title: `${what} isn't available yet`,
      description: "It connects once that backend ships — nothing was changed.",
    });

  const onAddToList = async () => {
    if (!contact) return;
    try {
      const { ok } = await addContactsToList("__default__", [contact.id]);
      if (ok) toast.success("Added to list");
      else notWired("Lists");
    } catch (e) {
      toast.error("Could not add to list", e instanceof Error ? e.message : undefined);
    }
  };

  const onEnroll = async () => {
    if (!contact) return;
    try {
      const { ok } = await enrollContacts([contact.id]);
      if (ok) toast.success("Enrolled");
      else notWired("Sequences");
    } catch (e) {
      toast.error("Could not enroll", e instanceof Error ? e.message : undefined);
    }
  };

  const location = contact
    ? [contact.locationCity, contact.locationCountry].filter(Boolean).join(", ") || "—"
    : "—";

  return (
    <Drawer
      open={open}
      onClose={closeDrawer}
      title={contact ? displayName(contact) : "Record"}
      width={480}
      footer={
        contact ? (
          <div className={styles.drawerActions}>
            <TpButton
              variant="primary"
              size="sm"
              leftIcon={<Sparkles size={15} />}
              onClick={() => setRevealType("full_profile")}
            >
              {contact.isRevealed ? "View revealed" : "Reveal"}
            </TpButton>
            <TpButton
              variant="ghost"
              size="sm"
              leftIcon={<ListPlus size={15} />}
              onClick={onAddToList}
            >
              Add to list
            </TpButton>
            <TpButton variant="ghost" size="sm" leftIcon={<Send size={15} />} onClick={onEnroll}>
              Enroll
            </TpButton>
            <TpButton
              variant="ghost"
              size="sm"
              leftIcon={<Download size={15} />}
              onClick={() => {
                exportMaskedCsv([contact], "contact.csv");
                toast.success("Exported");
              }}
            >
              Export
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
              <h3 className={styles.sectionTitle}>Identity</h3>
              <StatusBadge tone={dataHealthTone(contact)}>
                {contact.hasEmail ? EMAIL_STATUS_LABELS[contact.emailStatus] : "No email"}
              </StatusBadge>
            </div>
            <div className={styles.fieldGrid}>
              <Field
                label="Seniority"
                value={contact.seniorityLevel ? SENIORITY_LABELS[contact.seniorityLevel] : "—"}
              />
              <Field label="Department" value={contact.department ?? "—"} />
              <Field label="Location" value={location} />
              <Field label="Outreach" value={outreachStatus.replace(/_/g, " ")} />
              <Field
                label="Email"
                value={
                  contact.hasEmail
                    ? contact.emailDomain
                      ? `•••@${contact.emailDomain}`
                      : "•••"
                    : "—"
                }
              />
              <Field label="Phone" value={contact.hasPhone ? "Locked — reveal" : "—"} />
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Pipeline</h3>
            </div>
            {/* key per contact so the selector's local state remounts cleanly when switching records. */}
            <StageSelector
              key={contact.id}
              contactId={contact.id}
              stageId={null}
              onAssigned={(status) => setStatusOverride({ id: contact.id, status })}
            />
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Lead score</h3>
            </div>
            <ScoreBreakdown contactId={contact.id} />
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Provenance</h3>
            </div>
            <div className={styles.fieldGrid}>
              <Field
                label="Ownership"
                value={contact.isRevealed ? "Revealed in this workspace" : "Masked"}
              />
              <Field label="Added" value={new Date(contact.createdAt).toLocaleDateString()} />
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Custom fields</h3>
            </div>
            <CustomFieldsSection contactId={contact.id} />
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h3 className={styles.sectionTitle}>Activity</h3>
            </div>
            <ActivityTimeline contactId={contact.id} />
          </section>

          <RevealDialog
            contact={contact}
            revealType={revealType ?? "full_profile"}
            open={revealType !== null}
            onClose={() => setRevealType(null)}
            onRevealed={onRevealed}
          />
        </div>
      ) : null}
    </Drawer>
  );
}
