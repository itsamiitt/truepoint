// StageSelector.tsx — the record-detail pipeline-stage control (G-REV-7, ADR-0028). A minimal, self-contained
// TpSelect over the workspace's live stages: picking one assigns the contact to it and the SERVER rolls the
// contact's outreach_status up to the stage's maps_to_status (the UI never computes the rollup). "No stage"
// clears the assignment (the canonical status is left untouched server-side). When the backend isn't built or
// no stages exist yet, it renders an honest hint instead of an empty control. Presentation only.
"use client";

import type { OutreachStatus } from "@leadwolf/types";
import { StateSwitch, TpSelect, useToast } from "@leadwolf/ui";
import { useState } from "react";
import { useStages } from "../hooks/useStages";
import styles from "../prospect.module.css";
import { assignStage } from "../stagesApi";
import { OUTREACH_STATUS_LABELS } from "../types";

const NO_STAGE = "__none__";

export function StageSelector({
  contactId,
  stageId,
  /** Fired with the contact's resulting canonical status so the parent can reflect the rollup live. */
  onAssigned,
}: {
  contactId: string;
  /** The contact's currently-assigned stage id (null when unknown/unset). The parent should give this control
   *  a `key={contactId}` so the local selection state below remounts cleanly when the record switches. */
  stageId: string | null;
  onAssigned?: (status: OutreachStatus, stageId: string | null) => void;
}) {
  const toast = useToast();
  const { stages, available, error, loading, reload } = useStages();
  const [busy, setBusy] = useState(false);
  // Local mirror, seeded from the prop and remounted per contact via the parent's key. It reflects the pick
  // immediately; the server is the source of truth for the rolled-up status (returned by assignStage).
  const [current, setCurrent] = useState<string | null>(stageId);

  async function onChange(value: string): Promise<void> {
    const next = value === NO_STAGE ? null : value;
    setBusy(true);
    try {
      const result = await assignStage(contactId, next);
      setCurrent(result.stageId);
      onAssigned?.(result.outreachStatus, result.stageId);
      toast.success(
        next ? "Stage updated" : "Stage cleared",
        next ? `Now ${OUTREACH_STATUS_LABELS[result.outreachStatus]}.` : undefined,
      );
    } catch (e) {
      toast.error("Could not update stage", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <StateSwitch
      loading={loading}
      error={error}
      empty={!loading && available && (stages?.length ?? 0) === 0}
      onRetry={reload}
      emptyState={
        <p className={styles.fieldValue}>No stages defined yet — add them in pipeline settings.</p>
      }
    >
      {available ? (
        <TpSelect
          aria-label="Pipeline stage"
          value={current ?? NO_STAGE}
          disabled={busy}
          onChange={(e) => void onChange(e.target.value)}
        >
          <option value={NO_STAGE}>No stage</option>
          {(stages ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} → {OUTREACH_STATUS_LABELS[s.mapsToStatus]}
            </option>
          ))}
        </TpSelect>
      ) : (
        <p className={styles.fieldValue}>Pipeline stages connect once that backend ships.</p>
      )}
    </StateSwitch>
  );
}
