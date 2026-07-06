// ImportDraftsBanner.tsx — the "unfinished drafts" resume entry above the import history table (S-U7;
// 11 §2.1's slim Resume-draft alert over the 08 §7 `?state=draft` opt-in read). Gate-on by construction:
// gate-off the drafts query 404s (notEnabled) and this renders nothing — no draft can exist gate-off anyway.
// "Continue setup" deep-links the wizard's ?draft resume; "Discard" is the cancel-from-draft verb behind a
// confirm Dialog (destructive action ⇒ Dialog with the consequence stated — design skill). The 48 h copy is
// the reaper TTL (IMPORT_DRAFT_TTL_HOURS) — honest about how long a draft keeps.
"use client";

import { Alert, TpButton } from "@leadwolf/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { cancelImportJob } from "../apiV2";
import { useImportDrafts } from "../hooks/useImportDrafts";
import { importKeys } from "../keys";
import { formatRelative } from "./format";
import { ConfirmDialog } from "./shared/ConfirmDialog";

export function ImportDraftsBanner() {
  const router = useRouter();
  const qc = useQueryClient();
  const { drafts, notEnabled, isLoading } = useImportDrafts();
  const [discardId, setDiscardId] = useState<string | null>(null);

  const discard = useMutation({
    mutationFn: (jobId: string) => cancelImportJob(jobId),
    onSuccess: () => {
      setDiscardId(null);
      void qc.invalidateQueries({ queryKey: importKeys.all });
    },
  });

  if (isLoading || notEnabled || drafts.length === 0) return null;

  const discarding = drafts.find((d) => d.jobId === discardId) ?? null;

  return (
    <Alert role="status" style={{ marginBottom: "var(--tp-space-3)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--tp-space-2)" }}>
        <strong>
          Unfinished import{drafts.length === 1 ? "" : "s"} — continue where you left off
        </strong>
        {drafts.map((d) => (
          <div
            key={d.jobId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--tp-space-2)",
              flexWrap: "wrap",
            }}
          >
            <span>
              {d.sourceFilename ?? d.sourceName} — draft saved {formatRelative(d.createdAt)} (kept
              for 48 hours)
            </span>
            <TpButton
              variant="secondary"
              size="sm"
              type="button"
              onClick={() =>
                router.push(`/imports/new?draft=${encodeURIComponent(d.jobId)}&step=preview`)
              }
            >
              Continue setup
            </TpButton>
            <TpButton
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setDiscardId(d.jobId)}
            >
              Discard
            </TpButton>
          </div>
        ))}
        {discard.isError && (
          <span>
            Could not discard the draft
            {discard.error instanceof Error ? ` — ${discard.error.message}` : ""}. Try again.
          </span>
        )}
      </div>
      <ConfirmDialog
        open={discardId != null}
        onClose={() => setDiscardId(null)}
        title="Discard this draft?"
        body={`“${discarding?.sourceFilename ?? "This draft"}” and its uploaded file are deleted. Nothing has been imported from it.`}
        confirmLabel="Discard draft"
        destructive
        busy={discard.isPending}
        onConfirm={() => {
          if (discardId) discard.mutate(discardId);
        }}
      />
    </Alert>
  );
}
