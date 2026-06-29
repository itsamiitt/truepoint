// VersionHistoryDrawer.tsx — the immutable version history for one template (M12 P2). Lists every appended
// version (newest first) and, for the OWNER (canEdit), offers a one-click Restore that appends a NEW version
// cloning the chosen one — history is never mutated or lost. Read-only for a shared template the viewer doesn't
// own. Pure presentation over the api.ts seam; async chrome via the State Kit.
"use client";

import { Drawer, EmptyState, Icon, StateSwitch, TpButton } from "@leadwolf/ui";
import { History } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { fetchTemplateVersions, restoreTemplateVersion } from "../api";
import styles from "../sequences.module.css";
import { type TemplateVersion, formatEventDate } from "../types";

export function VersionHistoryDrawer({
  templateId,
  canEdit,
  currentVersion,
  open,
  onClose,
  onRestored,
}: {
  templateId: string;
  canEdit: boolean;
  currentVersion: number | null;
  open: boolean;
  onClose: () => void;
  onRestored: (version: number) => void;
}) {
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A restore failure surfaces on its OWN slot — it must never replace the loaded list via StateSwitch's
  // error branch (that `error` is reserved for the initial load).
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setVersions(await fetchTemplateVersions(templateId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load version history");
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function onRestore(version: number): Promise<void> {
    setRestoringVersion(version);
    setRestoreError(null);
    try {
      const result = await restoreTemplateVersion(templateId, version);
      onRestored(result.version);
      await load();
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : "Could not restore that version");
    } finally {
      setRestoringVersion(null);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Version history" width={440}>
      <StateSwitch
        loading={loading}
        error={error}
        onRetry={load}
        empty={versions.length === 0}
        emptyState={
          <EmptyState
            icon={<Icon icon={History} size={24} />}
            title="No versions yet"
            description="Each content edit appends an immutable version here."
          />
        }
      >
        {restoreError ? <p className={styles.templateFormError}>{restoreError}</p> : null}
        <ul className={styles.versionList}>
          {versions.map((v) => (
            <li key={v.version} className={styles.versionRow}>
              <div className={styles.versionMeta}>
                <span className={styles.versionNumber}>
                  v{v.version}
                  {v.version === currentVersion ? " · current" : ""}
                </span>
                <span className={styles.versionDate}>{formatEventDate(v.createdAt)}</span>
              </div>
              {v.subject ? <span className={styles.versionSubject}>{v.subject}</span> : null}
              <p className={styles.versionBody}>{v.body}</p>
              {canEdit && v.version !== currentVersion ? (
                <div className={styles.versionActions}>
                  <TpButton
                    variant="ghost"
                    size="sm"
                    onClick={() => void onRestore(v.version)}
                    loading={restoringVersion === v.version}
                    disabled={restoringVersion != null}
                  >
                    Restore
                  </TpButton>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </StateSwitch>
    </Drawer>
  );
}
