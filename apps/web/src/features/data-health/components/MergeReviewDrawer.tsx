// MergeReviewDrawer.tsx — the S-U8 side-by-side merge REVIEW panel (import-and-data-model-redesign 11 §5.2,
// rendering 04 §3/§6). Opens on a queue pair, fetches the masked field matrix + child-impact via the preview
// endpoint, and lets the reviewer pick a per-field winner (survivor-wins default; a PINNED survivor field is
// locked — DM6, mirrored not enforced client-side) before an IRREVERSIBLE confirm. Nothing merges here: the
// server enforces every decision. A gate-off 404 renders the honest "not enabled" state and tells the queue to
// hide the Merge affordance (dismiss-only survives). @leadwolf/ui only; tokens only; DS focus-trapped Drawer/Dialog.
"use client";

import type { DuplicatePairView, MergeRepointTallies } from "@leadwolf/types";
import {
  Badge,
  Dialog,
  Drawer,
  EmptyState,
  Icon,
  RadioGroup,
  RadioOption,
  StateSwitch,
  Tooltip,
  TpButton,
  useToast,
} from "@leadwolf/ui";
import { Copy, GitMerge, Pin } from "lucide-react";
import { useEffect, useState } from "react";
import styles from "../data-health.module.css";
import { useMergeContacts } from "../hooks/useMergeContacts";
import { useMergePreview } from "../hooks/useMergePreview";
import { type FieldPick, buildMergeDecisions } from "../mergeApi";

// Human labels for the seven pin-protected scalars the merge decides (CONTACT_PROVENANCE_FIELDS, 04 §3.2).
const FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  jobTitle: "Job title",
  seniorityLevel: "Seniority",
  department: "Department",
  locationCountry: "Country",
  locationCity: "City",
};

// Human labels for the re-point tallies (04 §4 Class-A child tables); unknown keys humanize their raw name.
const IMPACT_LABELS: Record<string, string> = {
  list_members: "List memberships",
  activities: "Activities",
  contact_reveals: "Reveals",
  record_tags: "Tags",
  outreach_log: "Outreach entries",
  email_message: "Email messages",
  email_thread: "Email threads",
  email_event: "Email events",
  sales_nav_links: "Sales Navigator links",
  scores: "Scores",
  intent_signals: "Intent signals",
};

const impactLabel = (key: string): string => IMPACT_LABELS[key] ?? key.replace(/_/g, " ");
const fmtValue = (v: string | null): string => (v == null || v === "" ? "—" : v);

function impactEntries(childImpact: MergeRepointTallies): [string, number][] {
  return Object.entries(childImpact).filter(([, n]) => n > 0);
}

export function MergeReviewDrawer({
  pair,
  onClose,
  onMerged,
  onNotEnabled,
}: {
  /** The queue pair under review; `null` closes the drawer. */
  pair: DuplicatePairView | null;
  onClose: () => void;
  /** Drop the resolved pair from the queue (keyed by the flagged duplicate id). */
  onMerged: (duplicateId: string) => void;
  /** The merge gate is dark — hide the Merge affordance across the queue (keep dismiss-only). */
  onNotEnabled: () => void;
}) {
  const toast = useToast();
  const merge = useMergeContacts();
  // Survivor/loser direction — the canonical is the suggested survivor (04 §3.2 creation-order heuristic);
  // a swap flips it.
  const [swapped, setSwapped] = useState(false);
  const [picks, setPicks] = useState<Record<string, FieldPick>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);

  const survivorId = pair ? (swapped ? pair.duplicateId : pair.canonicalId) : null;
  const loserId = pair ? (swapped ? pair.canonicalId : pair.duplicateId) : null;
  const survivorName = pair ? (swapped ? pair.duplicateName : pair.canonicalName) : "";
  const loserName = pair ? (swapped ? pair.canonicalName : pair.duplicateName) : "";

  const preview = useMergePreview(survivorId, loserId);
  const notEnabled = Boolean((preview.error as { notEnabled?: boolean } | null)?.notEnabled);

  // A new pair resets direction; picks reset on a new pair OR a swap (the fields' sides change).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on the pair identity only.
  useEffect(() => {
    setSwapped(false);
  }, [pair?.duplicateId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on the pair identity + direction.
  useEffect(() => {
    setPicks({});
    setConfirmOpen(false);
  }, [pair?.duplicateId, swapped]);

  // A dark merge gate: tell the queue to hide the Merge affordance (dismiss-only survives).
  useEffect(() => {
    if (notEnabled) onNotEnabled();
  }, [notEnabled, onNotEnabled]);

  const setPick = (field: string, winner: FieldPick) =>
    setPicks((cur) => ({ ...cur, [field]: winner }));

  function onConfirm(): void {
    if (!pair || !survivorId || !loserId) return;
    const decisions = buildMergeDecisions(preview.data?.fields ?? [], picks);
    merge.mutate(
      { survivorId, loserContactId: loserId, decisions },
      {
        onSuccess: () => {
          setConfirmOpen(false);
          toast.success("Contacts merged", `${loserName} was merged into ${survivorName}.`);
          onMerged(pair.duplicateId);
          onClose();
        },
        onError: (e) => {
          // Surfaces the RFC-9457 detail — daily-cap 429 / already-merged 409 read honestly.
          setConfirmOpen(false);
          toast.error("Couldn’t merge", e instanceof Error ? e.message : "Please try again.");
        },
      },
    );
  }

  const fields = preview.data?.fields ?? [];
  const impacts = preview.data ? impactEntries(preview.data.childImpact) : [];
  const showActions = Boolean(preview.data) && !notEnabled;

  return (
    <>
      <Drawer
        open={pair != null}
        onClose={onClose}
        title="Review duplicate"
        width={620}
        footer={
          showActions ? (
            <div className={styles.mergeFoot}>
              <TpButton variant="ghost" onClick={onClose}>
                Cancel
              </TpButton>
              <TpButton
                variant="danger"
                leftIcon={<GitMerge size={14} />}
                onClick={() => setConfirmOpen(true)}
              >
                Merge duplicate
              </TpButton>
            </div>
          ) : undefined
        }
      >
        {notEnabled ? (
          <EmptyState
            icon={<Icon icon={Copy} size={28} />}
            title="Merging isn’t enabled yet"
            description="You can still dismiss a wrong match with “Not a duplicate”. Merging duplicate contacts will light up here once it’s enabled for your workspace."
          />
        ) : (
          <StateSwitch
            loading={preview.isLoading}
            error={preview.error ? (preview.error as Error).message : null}
            onRetry={() => void preview.refetch()}
            empty={false}
          >
            {preview.data ? (
              <div className={styles.mergeBody}>
                {/* Survivor / loser identity + swap (04 §3.2 — the kept record keeps its ID + history). */}
                <div className={styles.mergeRecords}>
                  <div className={styles.recordCard}>
                    <span className={styles.recordRole}>Kept</span>
                    <span className={styles.recordName}>{survivorName}</span>
                  </div>
                  <div className={styles.recordCard}>
                    <span className={styles.recordRole}>Merged away</span>
                    <span className={styles.recordName}>{loserName}</span>
                  </div>
                </div>
                <div className={styles.mergeSwapRow}>
                  <span className={styles.footnote}>The kept contact keeps its ID and history.</span>
                  <TpButton variant="ghost" size="sm" onClick={() => setSwapped((s) => !s)}>
                    Swap
                  </TpButton>
                </div>

                {/* Per-field winner picks — survivor-wins default; pinned survivor is locked (DM6). */}
                <div className={styles.mergeFields}>
                  <div className={styles.mergeFieldsHead}>
                    <span className={styles.sectionHint}>Field</span>
                    <div className={styles.mergePicks}>
                      <span className={styles.sectionHint}>Keep</span>
                      <span className={styles.sectionHint}>Merged away</span>
                    </div>
                  </div>
                  {fields.map((f) => {
                    const pick: FieldPick = f.survivorPinned
                      ? "survivor"
                      : (picks[f.field] ?? "survivor");
                    const label = FIELD_LABELS[f.field] ?? f.field;
                    return (
                      <div key={f.field} className={styles.mergeField}>
                        <div className={styles.mergeFieldLabel}>
                          {label}
                          {f.survivorPinned ? (
                            <Tooltip label="Pinned — imports and merges never overwrite this">
                              <span className={styles.pinBadge}>
                                <Icon icon={Pin} size={11} /> Pinned
                              </span>
                            </Tooltip>
                          ) : null}
                        </div>
                        <RadioGroup
                          className={styles.mergePicks}
                          aria-label={`${label} — which value to keep`}
                        >
                          <RadioOption
                            name={`merge-${f.field}`}
                            checked={pick === "survivor"}
                            disabled={f.survivorPinned}
                            onChange={() => setPick(f.field, "survivor")}
                          >
                            <span className={styles.pickValue}>{fmtValue(f.survivorValue)}</span>
                          </RadioOption>
                          <RadioOption
                            name={`merge-${f.field}`}
                            checked={pick === "loser"}
                            disabled={f.survivorPinned}
                            onChange={() => setPick(f.field, "loser")}
                          >
                            <span className={styles.pickValue}>{fmtValue(f.loserValue)}</span>
                          </RadioOption>
                        </RadioGroup>
                      </div>
                    );
                  })}
                </div>

                {/* Channels are not a picker (04 §3.3) — stated as fact. */}
                <p className={styles.mergeNote}>
                  All emails and phones from both records are kept; the duplicate’s become secondary.
                </p>

                {/* Consequences: re-point counts + the irreversibility posture (04 §3, §3.6). */}
                {impacts.length > 0 ? (
                  <div className={styles.mergeImpact}>
                    <span className={styles.sectionHint}>What moves to the kept record</span>
                    <div className={styles.impactChips}>
                      {impacts.map(([key, n]) => (
                        <Badge key={key}>
                          {n.toLocaleString()} {impactLabel(key)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
                <p className={styles.mergeNote}>The duplicate is archived and can’t be unmerged.</p>
              </div>
            ) : null}
          </StateSwitch>
        )}
      </Drawer>

      {/* The explicit destructive confirm (design skill: irreversible ⇒ a real Dialog, never a toast-only act). */}
      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Merge these contacts?"
        maxWidth={460}
        footer={
          <div className={styles.mergeFoot}>
            <TpButton variant="ghost" onClick={() => setConfirmOpen(false)} disabled={merge.isPending}>
              Keep both
            </TpButton>
            <TpButton variant="danger" onClick={onConfirm} loading={merge.isPending}>
              Merge permanently
            </TpButton>
          </div>
        }
      >
        <p className={styles.footnote}>
          Merging is permanent — <strong>{loserName || "the duplicate"}</strong> will be archived
          and can’t be unmerged. Its contacts, activity, and list memberships move to{" "}
          <strong>{survivorName || "the kept contact"}</strong>, which keeps its ID and history.
        </p>
      </Dialog>
    </>
  );
}
