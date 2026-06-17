// StageManagementPanel.tsx — the workspace pipeline-stage management surface (G-REV-7, ADR-0028). Lists the
// workspace's stages with the canonical outreach_status each maps to, lets an admin add a stage (name + a
// mapping picker constrained to the canonical statuses) and archive one. Every mutation goes through the
// server (stagesApi); the mapping invariant + "one default" rule are enforced there. Presentation only — the
// panel never computes a rollup or invents a status. Renders honest empty/error/not-built states via the State Kit.
"use client";

import type { OutreachStatus } from "@leadwolf/types";
import {
  Card,
  EmptyState,
  StateSwitch,
  StatusBadge,
  TpButton,
  TpInput,
  TpSelect,
  useToast,
} from "@leadwolf/ui";
import { Archive, Plus } from "lucide-react";
import { useState } from "react";
import { useStages } from "../hooks/useStages";
import styles from "../prospect.module.css";
import { createStage, updateStage } from "../stagesApi";
import { OUTREACH_STATUS_LABELS, OUTREACH_STATUS_OPTIONS } from "../types";

export function StageManagementPanel() {
  const toast = useToast();
  const { stages, available, error, loading, reload } = useStages();
  const [name, setName] = useState("");
  const [mapsTo, setMapsTo] = useState<OutreachStatus>("new");
  const [busy, setBusy] = useState(false);

  async function onAdd(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name a stage", "Give the stage a name first.");
      return;
    }
    setBusy(true);
    try {
      await createStage({ name: trimmed, maps_to_status: mapsTo });
      setName("");
      setMapsTo("new");
      toast.success("Stage added");
      await reload();
    } catch (e) {
      toast.error("Could not add stage", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function onArchive(id: string): Promise<void> {
    try {
      await updateStage(id, { archived: true });
      toast.success("Stage archived");
      await reload();
    } catch (e) {
      toast.error("Could not archive stage", e instanceof Error ? e.message : undefined);
    }
  }

  return (
    <Card>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>Pipeline stages</h3>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!loading && available && (stages?.length ?? 0) === 0}
        onRetry={reload}
        emptyState={
          <EmptyState
            title="No stages yet"
            description="Add your first stage below — each maps to a canonical outreach status."
          />
        }
      >
        {available ? (
          <ul className={styles.timeline}>
            {(stages ?? []).map((s) => (
              <li className={styles.timelineItem} key={s.id}>
                <div className={styles.timelineMeta}>
                  <span className={styles.timelineType}>
                    {s.name}
                    {s.isDefault ? <StatusBadge tone="muted">Default</StatusBadge> : null}
                  </span>
                  <span className={styles.timelineTime}>
                    → {OUTREACH_STATUS_LABELS[s.mapsToStatus]}
                  </span>
                </div>
                <TpButton
                  variant="ghost"
                  size="sm"
                  leftIcon={<Archive size={14} />}
                  onClick={() => void onArchive(s.id)}
                >
                  Archive
                </TpButton>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            title="Not connected"
            description="Pipeline stages connect once that backend ships."
          />
        )}
      </StateSwitch>

      {available ? (
        <div className={styles.drawerActions}>
          <TpInput
            placeholder="Stage name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
          <TpSelect
            aria-label="Maps to status"
            value={mapsTo}
            onChange={(e) => setMapsTo(e.target.value as OutreachStatus)}
          >
            {OUTREACH_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </TpSelect>
          <TpButton
            size="sm"
            leftIcon={<Plus size={15} />}
            loading={busy}
            onClick={() => void onAdd()}
          >
            Add stage
          </TpButton>
        </div>
      ) : null}
    </Card>
  );
}
