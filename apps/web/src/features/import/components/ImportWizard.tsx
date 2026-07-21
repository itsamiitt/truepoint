// ImportWizard.tsx — the import surface: pick a source + CSV, map its columns to canonical fields, VALIDATE
// (a pre-commit preview the user must confirm — G-IMP-1), choose a conflict policy for matched duplicates
// (G-IMP-5), then run the import. TWO flows share this component (S-U7, import-redesign 11 §3):
// • The DRAFT-BACKED flow (gate-on, hand-off contexts only): picking a file POSTs it once as an S-I8 draft —
//   headers + the auto-map proposal come from the SERVER response, mapping PUTs on step-advance, Validate is
//   the full-pass server preview, Confirm commits with an Idempotency-Key, and the wizard steps
//   Map → Preview → Confirm with ?step=/?draft= deep-links and resume. Upload-once: the file is never
//   re-read; replacing it discards the draft (cancel verb) behind a confirm Dialog.
// • The LEGACY one-shot flow (gate-off, and always the "import into list" dialog): headers are read
//   client-side only to populate the mapper, autoMapHeaders pre-fills it, and submit carries everything in
//   one request — byte-identical to the shipped card (the canary rule: gate-off, ZERO behavior change).
"use client";

import type {
  CanonicalField,
  ColumnMapping,
  ConflictPolicy,
  ImportMappingTemplate,
  ImportMergeMode,
  ImportPreview,
  SourceName,
} from "@leadwolf/types";
import { ErrorState, TpButton, TpCheckbox, TpInput, TpSelect } from "@leadwolf/ui";
import { useEffect, useRef, useState } from "react";
import { listMappingTemplates, postImport, postImportPreview, saveMappingTemplate } from "../api";
import { type DraftStep, filterMappingToMappable } from "../draftFlow";
import { useImport } from "../hooks/useImport";
import { type DraftUrlState, useImportDraft } from "../hooks/useImportDraft";
import { rejectedRowsToCsv } from "../rejectedRowsCsv";
import { IDENTITY_FIELDS, MAPPABLE_FIELDS, MERGE_OPTIONS, SOURCE_OPTIONS } from "../types";
import { ImportDraftFlow } from "./ImportDraftFlow";
import { MappingGrid } from "./MappingGrid";
import { ConfirmDialog } from "./shared/ConfirmDialog";
import { TemplateControls } from "./TemplateControls";

/** Map the chosen merge mode onto the legacy conflict policy so gate-off imports still honor the intent
 *  (08 §5's compatibility mapping, mirrored client-side). `update_only` has no legacy equivalent — it falls
 *  back to `skip` gate-off (the new capability only takes effect gate-on). */
function mergeModeToConflictPolicy(mode: ImportMergeMode): ConflictPolicy {
  return mode === "create_and_update" ? "overwrite" : "skip";
}

/** Normalize a header/label for auto-mapping: lowercase, strip everything but a–z0–9 (so "First Name",
 *  "first_name", "firstname" all collapse to one key). */
function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when the picked file is an OOXML workbook (.xlsx) — drives the header reader. Matches the server's
 *  isXlsxFile dispatch (xlsx only, not legacy .xls); kept local because the web app must not depend on
 *  @leadwolf/core (which reaches the DB) just to share this one-line predicate. */
function isXlsx(file: File): boolean {
  return /\.xlsx$/i.test(file.name);
}

/** Read just the header row to populate the column mapper — the GATE-OFF fallback only (S-U7: gate-on, the
 *  draft ref carries the server-parsed headers and this never runs). CSV is read inline (first line); XLSX
 *  uses SheetJS, dynamically imported so the parser is code-split and never loaded on the (common) CSV path. */
async function readHeaders(file: File): Promise<string[]> {
  if (isXlsx(file)) {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", sheetRows: 1 });
    const sheetName = wb.SheetNames[0];
    const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
    if (!sheet) return [];
    const matrix = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
    }) as unknown[][];
    return (matrix[0] ?? []).map((h) => String(h ?? "").trim()).filter(Boolean);
  }
  const firstLine = (await file.text()).split(/\r?\n/)[0] ?? "";
  return firstLine
    .split(",")
    .map((h) => h.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** Auto-map headers → canonical fields by normalized-name match — the GATE-OFF fallback (S-U7: gate-on the
 *  server's alias-table proposal wins, packages/core headerAliases.ts). BINARY, not fuzzy-with-confidence
 *  (03 §1: no fake percentages); every match is user-overridable via the same dropdowns. */
function autoMapHeaders(headers: string[]): Partial<Record<CanonicalField, string>> {
  const next: Partial<Record<CanonicalField, string>> = {};
  const used = new Set<string>();
  for (const mf of MAPPABLE_FIELDS) {
    const targets = new Set([normalizeKey(mf.label), normalizeKey(mf.field)]);
    const match = headers.find((h) => !used.has(h) && targets.has(normalizeKey(h)));
    if (match) {
      next[mf.field] = match;
      used.add(match);
    }
  }
  return next;
}

/** Trigger a client-side download of `csv` as a CSV file (no server round-trip — the data is already local). */
function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface ImportWizardProps {
  /** Inline-completion callback: fired once per completed import in the INLINE flow (the "import into list"
   *  dialog, which reads the receipt in place). Unused in the hand-off flow — there the job runs on its own
   *  durable page. Optional so the page context can omit it. */
  onImported?: () => void;
  /** Hand-off callback (import-redesign 11 §4, S-U3): when provided, submitting ENQUEUES the import and calls
   *  this with the new job id INSTEAD of polling inline — the parent navigates to the durable job page
   *  (/imports/:jobId), which polls without ever giving up (the G11 fix). When absent, the wizard keeps the
   *  inline poll + receipt (the dialog reuse) — and the S-U7 draft path never engages (its commit hand-off
   *  targets the durable job page; the dialog's receipt reads in place). */
  onStarted?: (jobId: string) => void;
  /** When set, this import targets a list (list-plan/03 §2.2): the `listId` is sent with the upload and every
   *  landed row is added to that list. `targetListName` is display-only (the receipt/title); the SERVER trusts
   *  only the id, validated against the caller's workspace. */
  targetListId?: string;
  targetListName?: string;
  /** `?draft=` deep-link (S-U7 resume): re-enter this draft. Page contexts only; ignored gate-off. */
  resumeDraftId?: string | null;
  /** `?step=` deep-link, already parsed by the page. */
  initialStep?: DraftStep | null;
  /** URL sync for the draft flow (the page mirrors step/draft into the query string; null = left draft mode). */
  onDraftUrlChange?: (state: DraftUrlState | null) => void;
}

export function ImportWizard({
  onImported,
  onStarted,
  targetListId,
  targetListName,
  resumeDraftId,
  initialStep,
  onDraftUrlChange,
}: ImportWizardProps) {
  const { status, jobId, summary, error, busy, run } = useImport();
  // Hand-off (onStarted) submit state — kept separate from useImport, which drives only the inline flow.
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [sourceName, setSourceName] = useState<SourceName>("manual");
  const [mapping, setMapping] = useState<Partial<Record<CanonicalField, string>>>({});
  // The visible dedup strategy (08 §5, S-U4): the merge-mode triad + the orthogonal "don't overwrite populated
  // values" switch. A legacy conflictPolicy is derived at submit so gate-off imports honor the intent too.
  const [mergeMode, setMergeMode] = useState<ImportMergeMode>("create_and_update");
  const [preservePopulated, setPreservePopulated] = useState(false);

  // Pre-commit validation preview (G-IMP-1): the user validates first, then confirms to run the real import.
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Saved mapping templates (G-IMP-3): the workspace's named, replayable column maps. Applying one pre-fills
  // the mapper; saving the current map (re)creates a named template by upsert. Additive to the import flow.
  const [templates, setTemplates] = useState<ImportMappingTemplate[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [templateMsg, setTemplateMsg] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  // Provenance for the draft PUT: the applied template's id, cleared on any manual mapping edit.
  const [appliedTemplateId, setAppliedTemplateId] = useState<string | undefined>(undefined);

  // ── S-U7 draft flow (gate-on, hand-off contexts only) ────────────────────────────────────────────────
  const draft = useImportDraft({
    active: Boolean(onStarted),
    resumeDraftId,
    initialStep,
    onUrlChange: onDraftUrlChange,
    onResumedCommitted: onStarted,
  });
  // Replace-file confirm (upload-once: a new file means discarding the current draft — Dialog first).
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  // Bumped to re-mount the (uncontrolled) file input when a pick is cancelled or the draft is replaced.
  const [fileInputKey, setFileInputKey] = useState(0);

  useEffect(() => {
    let active = true;
    listMappingTemplates()
      .then((t) => {
        if (active) setTemplates(t);
      })
      .catch(() => {
        /* templates are a convenience — a load failure must never block importing */
      });
    return () => {
      active = false;
    };
  }, []);

  function onApplyTemplate(id: string): void {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    // Keep only fields the mapper actually renders a control for, so an API-/automation-created template
    // can never inject hidden, un-editable mapping state that would silently ride along on import.
    setMapping(filterMappingToMappable(t.mapping));
    setAppliedTemplateId(t.id);
    setTemplateName(t.name);
    setTemplateMsg(`Applied template "${t.name}".`);
  }

  async function onSaveTemplate(): Promise<void> {
    const name = templateName.trim();
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapping)) if (v) cleaned[k] = v;
    if (!name || Object.keys(cleaned).length === 0) return;
    setSavingTemplate(true);
    setTemplateMsg(null);
    try {
      const saved = await saveMappingTemplate({ name, mapping: cleaned as ColumnMapping });
      // Upsert into the local list (replace a same-id match, else prepend).
      setTemplates((prev) => [saved, ...prev.filter((t) => t.id !== saved.id)]);
      setTemplateMsg(`Saved template "${saved.name}".`);
    } catch (e) {
      setTemplateMsg(e instanceof Error ? e.message : "Could not save template.");
    } finally {
      setSavingTemplate(false);
    }
  }

  // Notify the parent exactly once per completed import (the job settles asynchronously via polling, so this
  // can't be done inline in onSubmit). The ref guards against re-firing on unrelated re-renders.
  const notifiedRef = useRef(false);
  useEffect(() => {
    if (status === "done" && summary && !notifiedRef.current) {
      notifiedRef.current = true;
      onImported?.();
    }
  }, [status, summary, onImported]);

  function cleanedMapping(): ColumnMapping {
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapping)) if (v) cleaned[k] = v;
    return cleaned as ColumnMapping;
  }

  // Re-mapping or re-picking a file invalidates a stale preview — the user must validate again before commit.
  function invalidatePreview(): void {
    setPreview(null);
    setPreviewError(null);
  }

  function onMappingChange(field: CanonicalField, value: string): void {
    setMapping((m) => ({ ...m, [field]: value }));
    setAppliedTemplateId(undefined);
    invalidatePreview();
  }

  /** Adopt a picked file: gate-on-TRY the S-I8 draft path first (upload-once; SERVER headers + auto-map
   *  proposal win); any fall-through keeps today's client-side read — the canary rule. */
  async function adoptFile(f: File | null): Promise<void> {
    setFile(f);
    invalidatePreview();
    setAppliedTemplateId(undefined);
    if (f) {
      const created = await draft.tryCreateDraft(f, sourceName, targetListId);
      if (created) {
        setHeaders(created.headers);
        setMapping(filterMappingToMappable(created.suggestedMapping));
        return;
      }
    }
    const hdrs = f ? await readHeaders(f) : [];
    setHeaders(hdrs);
    // Auto-map on load (S-U4): pre-fill the mapper from the headers; the user reviews/overrides before validating.
    setMapping(hdrs.length > 0 ? autoMapHeaders(hdrs) : {});
  }

  async function onFile(f: File | null): Promise<void> {
    // Upload-once: while a draft backs the wizard, a new file means discarding it — confirm first (11 §3).
    if (f && draft.inDraftMode) {
      setPendingFile(f);
      return;
    }
    await adoptFile(f);
  }

  const identityMapped = IDENTITY_FIELDS.some((f) => mapping[f]);
  const canValidate = Boolean(file) && identityMapped && !previewBusy && !busy && !starting;
  const canSubmit = Boolean(file) && identityMapped && preview !== null && !busy && !starting;

  async function onValidate(): Promise<void> {
    if (!file) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const p = await postImportPreview({ file, sourceName, mapping: cleanedMapping() });
      setPreview(p);
    } catch (e) {
      setPreview(null);
      setPreviewError(e instanceof Error ? e.message : "Could not validate the file.");
    } finally {
      setPreviewBusy(false);
    }
  }

  function onSubmit(): void {
    if (!file || !preview) return;
    const args = {
      file,
      sourceName,
      mapping: cleanedMapping(),
      conflictPolicy: mergeModeToConflictPolicy(mergeMode),
      mergeMode,
      preservePopulated,
      listId: targetListId,
    };
    // Hand-off flow (11 §4, S-U3): enqueue, then let the parent navigate to the durable job page. No inline
    // poll — the job page owns progress/completion and never gives up.
    if (onStarted) {
      setStarting(true);
      setStartError(null);
      void (async () => {
        try {
          const ref = await postImport(args);
          onStarted(ref.jobId); // parent navigates away; this component unmounts
        } catch (e) {
          setStartError(e instanceof Error ? e.message : "Import failed to start.");
          setStarting(false);
        }
      })();
      return;
    }
    // Inline flow (the "import into list" dialog): poll to completion and show the receipt in place.
    notifiedRef.current = false;
    run(args);
  }

  function onDownloadRejected(): void {
    if (!summary || summary.rejectedRows.length === 0) return;
    const base = (file?.name ?? "import").replace(/\.(csv|xlsx?)$/i, "");
    downloadCsv(rejectedRowsToCsv(summary.rejectedRows), `${base}-rejected.csv`);
  }

  const fileInputNode = (
    <TpInput
      key={fileInputKey}
      type="file"
      accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
    />
  );

  // The template bar + mapping grid, shared verbatim by both flows (legacy DOM order preserved inside
  // TemplateControls — apply select · grid · save row · message).
  const mappingSectionNode =
    headers.length > 0 ? (
      <>
        <TemplateControls
          templates={templates}
          onApply={onApplyTemplate}
          templateName={templateName}
          onTemplateName={setTemplateName}
          onSave={() => void onSaveTemplate()}
          saving={savingTemplate}
          canSave={Boolean(templateName.trim()) && identityMapped}
          message={templateMsg}
        >
          <MappingGrid headers={headers} mapping={mapping} onChange={onMappingChange} />
        </TemplateControls>
        {!identityMapped && (
          <p className="app-muted">
            Map at least one identity field (Email, LinkedIn, or Sales Nav id) to continue.
          </p>
        )}
      </>
    ) : null;

  const heading = targetListName ? `Import into “${targetListName}”` : "Import contacts";
  const intro = targetListName
    ? `Upload a CSV or XLSX, map its columns, validate, and we’ll dedupe and add the rows to “${targetListName}”.`
    : "Upload a CSV or XLSX, map its columns, validate, and we’ll dedupe into this workspace.";

  // ── Draft-backed rendering (gate-on only; never mounts gate-off — the canary rule) ───────────────────
  if (draft.inDraftMode && onStarted) {
    return (
      <section className="tp-card">
        <h2>{heading}</h2>
        <p className="app-muted">{intro}</p>
        <ImportDraftFlow
          draft={draft}
          fileName={file?.name ?? draft.ref?.sourceFilename ?? draft.resume?.sourceFilename ?? "your file"}
          fileInput={fileInputNode}
          mergeControls={
            <>
              <div className="tp-row">
                <label className="tp-field">
                  <span>When a row matches an existing contact</span>
                  <TpSelect
                    value={mergeMode}
                    onChange={(e) => setMergeMode(e.target.value as ImportMergeMode)}
                  >
                    {MERGE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </TpSelect>
                </label>
              </div>
              {mergeMode !== "create_only" && (
                <div className="tp-row">
                  <TpCheckbox
                    checked={preservePopulated}
                    onChange={(e) => setPreservePopulated(e.target.checked)}
                    label="Don’t overwrite fields that already have a value (fill only what’s empty)"
                  />
                </div>
              )}
            </>
          }
          mappingSection={mappingSectionNode}
          identityMapped={identityMapped}
          mapping={cleanedMapping()}
          appliedTemplateId={appliedTemplateId}
          mergeMode={mergeMode}
          preservePopulated={preservePopulated}
          targetListName={targetListName}
          onStarted={onStarted}
          onDiscarded={() => {
            setFile(null);
            setHeaders([]);
            setMapping({});
            setAppliedTemplateId(undefined);
            setFileInputKey((k) => k + 1);
            invalidatePreview();
          }}
        />
        <ConfirmDialog
          open={pendingFile != null}
          onClose={() => {
            setPendingFile(null);
            setFileInputKey((k) => k + 1); // re-mount the input so the cancelled pick doesn't linger
          }}
          title="Replace the uploaded file?"
          body="Choosing a different file discards this draft — the uploaded copy and your column mapping for it are deleted."
          confirmLabel="Replace file"
          destructive
          busy={draft.busy === "discard"}
          onConfirm={() => {
            const next = pendingFile;
            setPendingFile(null);
            setFileInputKey((k) => k + 1);
            // Best-effort discard (a failed cancel leaves an orphan draft the 48 h reaper collects).
            void draft.discard({ silent: true }).then(() => void adoptFile(next));
          }}
        />
      </section>
    );
  }

  // ── Legacy one-shot card (gate-off byte-identical; also the dialog's inline flow) ────────────────────
  return (
    <section className="tp-card">
      <h2>{heading}</h2>
      <p className="app-muted">{intro}</p>

      {draft.resumeNote && <p className="app-muted">{draft.resumeNote}</p>}

      <div className="tp-row">
        <label className="tp-field">
          <span>Source</span>
          <TpSelect
            value={sourceName}
            onChange={(e) => {
              setSourceName(e.target.value as SourceName);
              invalidatePreview();
            }}
          >
            {SOURCE_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </TpSelect>
        </label>
        <label className="tp-field">
          <span>CSV or XLSX file</span>
          {fileInputNode}
        </label>
        <label className="tp-field">
          <span>When a row matches an existing contact</span>
          <TpSelect
            value={mergeMode}
            onChange={(e) => setMergeMode(e.target.value as ImportMergeMode)}
          >
            {MERGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </TpSelect>
        </label>
      </div>

      {mergeMode !== "create_only" && (
        <div className="tp-row">
          <TpCheckbox
            checked={preservePopulated}
            onChange={(e) => setPreservePopulated(e.target.checked)}
            label="Don’t overwrite fields that already have a value (fill only what’s empty)"
          />
        </div>
      )}

      {draft.busy === "create" && <p className="app-muted">Uploading file…</p>}
      {draft.flowError && (
        <ErrorState title="Couldn’t upload the file" detail={draft.flowError} />
      )}

      {mappingSectionNode}

      <div className="tp-row">
        <TpButton
          variant="secondary"
          type="button"
          disabled={!canValidate}
          onClick={() => void onValidate()}
        >
          {previewBusy ? "Validating…" : "Validate"}
        </TpButton>
        <TpButton variant="primary" type="button" disabled={!canSubmit} onClick={onSubmit}>
          {starting || status === "submitting"
            ? "Uploading…"
            : status === "processing"
              ? "Processing…"
              : "Confirm & import"}
        </TpButton>
      </div>

      {previewError && <ErrorState title="Couldn’t validate the file" detail={previewError} />}
      {startError && <ErrorState title="Couldn’t start the import" detail={startError} />}

      {preview && status !== "done" && (
        <div className="tp-summary">
          <strong>Validation preview.</strong> {preview.valid} valid · {preview.duplicate} duplicate
          {preview.duplicate === 1 ? "" : "s"} · {preview.rejected} rejected (of {preview.total}{" "}
          rows)
          {preview.rejected > 0 ? (
            <>
              <p className="app-muted">
                Confirm to import the valid rows. Rejected rows will be downloadable after the
                import.
              </p>
              {preview.sampleRejectedRows.length > 0 && (
                <ul className="tp-errors">
                  {preview.sampleRejectedRows.slice(0, 5).map((r, i) => (
                    <li key={`${r.row}-${r.field ?? "row"}-${i}`}>
                      Row {r.row + 1}
                      {r.field ? ` (${r.field})` : ""}: {r.reason}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="app-muted">All rows passed validation — confirm to import.</p>
          )}
        </div>
      )}

      {status === "processing" && (
        <p className="app-muted">
          Import queued — processing in the background…
          {jobId && (
            <>
              {" "}
              (job <code>{jobId}</code>)
            </>
          )}
        </p>
      )}

      {error && <ErrorState title="Import failed" detail={error} />}

      {status === "done" && summary && (
        <div className="tp-summary">
          <strong>Import complete.</strong> {summary.created} new · {summary.matched} matched ·{" "}
          {summary.duplicates} duplicate{summary.duplicates === 1 ? "" : "s"} · {summary.skipped}{" "}
          skipped
          {summary.rejected > 0 && <> · {summary.rejected} rejected</>}
          {targetListId && (
            <p className="app-muted">
              {summary.addedToList.toLocaleString()} contact
              {summary.addedToList === 1 ? "" : "s"} added to
              {targetListName ? ` “${targetListName}”` : " the list"}.
            </p>
          )}
          {Object.keys(summary.rejectHistogram).length > 0 && (
            <div className="app-muted">
              <span>Why rows were rejected:</span>
              <ul className="tp-errors">
                {Object.entries(summary.rejectHistogram)
                  .sort((a, b) => b[1] - a[1])
                  .map(([label, count]) => (
                    <li key={label}>
                      {label}: {count.toLocaleString()}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {summary.rejectedRows.length > 0 && (
            <p>
              <TpButton variant="secondary" type="button" onClick={onDownloadRejected}>
                Download rejected rows ({summary.rejected})
              </TpButton>
            </p>
          )}
          {summary.rejectedRows.length > 0 && (
            <ul className="tp-errors">
              {summary.rejectedRows.slice(0, 5).map((r, i) => (
                // Two reasons can share a row, so the row index alone is not a unique key.
                <li key={`${r.row}-${r.field ?? "row"}-${i}`}>
                  Row {r.row + 1}
                  {r.field ? ` (${r.field})` : ""}: {r.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
