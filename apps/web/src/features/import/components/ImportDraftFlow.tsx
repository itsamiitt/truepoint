// ImportDraftFlow.tsx — the draft-backed wizard body (S-U7; 11 §3 over the shipped S-I8 verbs). Renders the
// three-step flow (Map → Preview → Confirm) that exists ONLY while a server draft backs the wizard —
// gate-off never mounts this (the canary rule: the one-shot card stays byte-identical). Upload-once holds:
// the file was POSTed at pick; every later verb references the draft, never the bytes. The parent
// (ImportWizard) owns the shared mapping/strategy state and passes the map-step controls as nodes so the
// two flows render the exact same mapper; this component owns step rendering + the verbs via the hook.
"use client";

import type { ColumnMapping, ImportMergeMode } from "@leadwolf/types";
import { ErrorState, TpButton } from "@leadwolf/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  DRAFT_STEPS,
  previewBlocked,
  previewContinueLabel,
  stepHeading,
} from "../draftFlow";
import type { ImportDraftController } from "../hooks/useImportDraft";
import { strategySentence } from "../types";
import { ImportDraftPreviewPanel } from "./ImportDraftPreviewPanel";
import { ConfirmDialog } from "./shared/ConfirmDialog";

export function ImportDraftFlow({
  draft,
  fileName,
  fileInput,
  mergeControls,
  mappingSection,
  identityMapped,
  mapping,
  appliedTemplateId,
  mergeMode,
  preservePopulated,
  targetListName,
  onStarted,
  onDiscarded,
}: {
  draft: ImportDraftController;
  fileName: string;
  /** The wizard's file input — picking a file here routes through the replace-draft confirm upstream. */
  fileInput: ReactNode;
  /** The merge-mode/preserve controls (map step only; strategy PUTs with the mapping on advance). */
  mergeControls: ReactNode;
  /** Template bar + mapping grid + identity hint — the same nodes the one-shot card renders. */
  mappingSection: ReactNode;
  identityMapped: boolean;
  mapping: ColumnMapping;
  appliedTemplateId?: string;
  mergeMode: ImportMergeMode;
  preservePopulated: boolean;
  targetListName?: string;
  onStarted: (jobId: string) => void;
  /** Fired after a confirmed discard — the parent clears its file/mapping state (fresh card). */
  onDiscarded?: () => void;
}) {
  const step = draft.step ?? "map";
  const summary = draft.preview?.summary ?? null;
  const busy = draft.busy != null;
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // §7.2 focus management: on step change, focus moves to the step heading (tabIndex −1) so keyboard and
  // screen-reader users land on the new step, not wherever the old button was.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const prevStepRef = useRef(step);
  useEffect(() => {
    if (prevStepRef.current !== step) {
      prevStepRef.current = step;
      headingRef.current?.focus();
    }
  }, [step]);

  const resumeMode = draft.isResume;
  const confirmMergeMode = resumeMode ? (draft.resume?.mergeMode ?? null) : mergeMode;
  const confirmPreserve = resumeMode ? (draft.resume?.preservePopulated ?? null) : preservePopulated;
  const mappedCount = resumeMode ? null : Object.keys(mapping).length;

  async function onCommit(): Promise<void> {
    const jobId = await draft.commit();
    if (jobId) onStarted(jobId);
  }

  return (
    <div>
      {/* Step indicator — token-styled list with aria-current (Stepper is a named DS gap, 11 §8.3). */}
      <ol
        aria-label="Import setup steps"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--tp-space-3)",
          listStyle: "none",
          padding: 0,
          margin: "var(--tp-space-3) 0",
        }}
      >
        {DRAFT_STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={s === step ? "step" : undefined}
            style={{
              fontSize: 13,
              color: s === step ? "var(--tp-ink)" : "var(--tp-ink-3)",
              fontWeight: s === step ? 600 : 400,
            }}
          >
            {i + 1}. {stepHeading(s)}
          </li>
        ))}
      </ol>

      <h3 ref={headingRef} tabIndex={-1} style={{ margin: "0 0 var(--tp-space-2)" }}>
        {stepHeading(step)}
      </h3>

      <div className="tp-row">
        <p className="app-muted" style={{ margin: 0 }}>
          <strong>{fileName}</strong> — uploaded once; validation and the import run from this copy.
        </p>
        <label className="tp-field">
          <span>Choose a different file</span>
          {fileInput}
        </label>
      </div>

      {step === "map" && (
        <>
          {mergeControls}
          {mappingSection}
          <div className="tp-row">
            <TpButton
              variant="primary"
              type="button"
              disabled={!identityMapped || busy}
              onClick={() =>
                void draft.advanceFromMap({
                  mapping,
                  templateId: appliedTemplateId,
                  mergeMode,
                  preservePopulated,
                })
              }
            >
              {draft.busy === "advance" ? "Validating…" : "Continue to validation"}
            </TpButton>
          </div>
        </>
      )}

      {step === "preview" && (
        <>
          <ImportDraftPreviewPanel
            preview={draft.preview}
            cached={draft.previewIsCached}
            busy={draft.busy === "preview"}
            onRerun={() => void draft.rerunPreview()}
          />
          {resumeMode && (
            <p className="app-muted">
              This draft’s column mapping was saved when it was set up. To change the mapping, discard the
              draft and upload the file again.
            </p>
          )}
          {previewBlocked(summary) && (
            <p className="app-muted">
              Every row failed validation — fix the file{resumeMode ? "" : " or the mapping"} and try again.
            </p>
          )}
          <div className="tp-row">
            {!resumeMode && (
              <TpButton variant="secondary" type="button" disabled={busy} onClick={() => draft.goToStep("map")}>
                Back
              </TpButton>
            )}
            <TpButton
              variant="primary"
              type="button"
              disabled={summary == null || previewBlocked(summary) || busy}
              onClick={() => draft.goToStep("confirm")}
            >
              {previewContinueLabel(summary)}
            </TpButton>
          </div>
        </>
      )}

      {step === "confirm" && (
        <>
          <div className="tp-summary">
            <strong>Ready to run.</strong>
            <p className="app-muted">
              {fileName}
              {mappedCount != null &&
                ` · ${mappedCount.toLocaleString()} column${mappedCount === 1 ? "" : "s"} mapped`}
              {` · ${strategySentence(confirmMergeMode, confirmPreserve)}`}
              {targetListName ? ` · into “${targetListName}”` : ""}
            </p>
            {summary && (
              <p className="app-muted">
                {summary.valid.toLocaleString()} of {summary.total.toLocaleString()} rows will be imported
                ({summary.wouldCreate.toLocaleString()} new · {summary.wouldUpdate.toLocaleString()} updates
                {summary.rejected > 0 ? ` · ${summary.rejected.toLocaleString()} skipped as rejected` : ""}).
              </p>
            )}
          </div>
          <div className="tp-row">
            <TpButton variant="secondary" type="button" disabled={busy} onClick={() => draft.goToStep("preview")}>
              Back
            </TpButton>
            <TpButton variant="primary" type="button" disabled={busy} onClick={() => void onCommit()}>
              {draft.busy === "commit" ? "Starting…" : "Run import"}
            </TpButton>
          </div>
        </>
      )}

      <div className="tp-row">
        <TpButton variant="ghost" type="button" disabled={busy} onClick={() => setConfirmDiscard(true)}>
          Discard draft
        </TpButton>
      </div>

      {draft.flowError && <ErrorState title="Something went wrong" detail={draft.flowError} />}

      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Discard this draft?"
        body="The uploaded file and this setup are deleted. Nothing has been imported yet."
        confirmLabel="Discard draft"
        destructive
        busy={draft.busy === "discard"}
        onConfirm={() => {
          void draft.discard().then((ok) => {
            if (ok) {
              setConfirmDiscard(false);
              onDiscarded?.();
            }
          });
        }}
      />
    </div>
  );
}
