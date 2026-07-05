// ImportWizard.tsx — the import surface: pick a source + CSV, map its columns to canonical fields, VALIDATE
// (a pre-commit preview the user must confirm — G-IMP-1), choose a conflict policy for matched duplicates
// (G-IMP-5), then run the import. Headers are read client-side only to populate the mapper's dropdowns (the
// server does the authoritative RFC-4180 parse + dedup in packages/core). A cohesive feature component;
// presentation + local view state only — the actual import runs server-side: useImport enqueues a background
// job and POLLS it to completion, surfacing a queued → processing → done/failed lifecycle. The rejected rows
// on a completed import are downloadable as a CSV error file (raw row + per-field reason) so the user can fix
// and re-import only the failures.
"use client";

import type {
  CanonicalField,
  ColumnMapping,
  ConflictPolicy,
  ImportMappingTemplate,
  ImportPreview,
  SourceName,
} from "@leadwolf/types";
import { ErrorState, TpButton, TpInput, TpSelect } from "@leadwolf/ui";
import { useEffect, useRef, useState } from "react";
import { listMappingTemplates, postImport, postImportPreview, saveMappingTemplate } from "../api";
import { useImport } from "../hooks/useImport";
import { rejectedRowsToCsv } from "../rejectedRowsCsv";
import { IDENTITY_FIELDS, MAPPABLE_FIELDS, type MappableField, SOURCE_OPTIONS } from "../types";

const GROUPS = ["Identity", "Person", "Company", "Location"] as const;

const CONFLICT_OPTIONS: { value: ConflictPolicy; label: string }[] = [
  { value: "skip", label: "Skip — keep existing contact (no overwrite)" },
  { value: "overwrite", label: "Overwrite — update existing contact" },
  { value: "keep_both", label: "Keep both — new rows added; existing matches kept as-is" },
];

/** True when the picked file is an OOXML workbook (.xlsx) — drives the header reader. Matches the server's
 *  isXlsxFile dispatch (xlsx only, not legacy .xls); kept local because the web app must not depend on
 *  @leadwolf/core (which reaches the DB) just to share this one-line predicate. */
function isXlsx(file: File): boolean {
  return /\.xlsx$/i.test(file.name);
}

/** Read just the header row to populate the column mapper. CSV is read inline (first line); XLSX uses SheetJS,
 *  dynamically imported so the parser is code-split and never loaded on the (common) CSV path. The authoritative
 *  parse + dedup still runs server-side in packages/core — this only fills the mapper's dropdowns. */
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
   *  inline poll + receipt (the dialog reuse). */
  onStarted?: (jobId: string) => void;
  /** When set, this import targets a list (list-plan/03 §2.2): the `listId` is sent with the upload and every
   *  landed row is added to that list. `targetListName` is display-only (the receipt/title); the SERVER trusts
   *  only the id, validated against the caller's workspace. */
  targetListId?: string;
  targetListName?: string;
}

export function ImportWizard({ onImported, onStarted, targetListId, targetListName }: ImportWizardProps) {
  const { status, jobId, summary, error, busy, run } = useImport();
  // Hand-off (onStarted) submit state — kept separate from useImport, which drives only the inline flow.
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [sourceName, setSourceName] = useState<SourceName>("manual");
  const [mapping, setMapping] = useState<Partial<Record<CanonicalField, string>>>({});
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>("skip");

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
    const next: Partial<Record<CanonicalField, string>> = {};
    for (const mf of MAPPABLE_FIELDS) {
      const header = t.mapping[mf.field];
      if (header) next[mf.field] = header;
    }
    setMapping(next);
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

  async function onFile(f: File | null): Promise<void> {
    setFile(f);
    setMapping({});
    invalidatePreview();
    setHeaders(f ? await readHeaders(f) : []);
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
    const args = { file, sourceName, mapping: cleanedMapping(), conflictPolicy, listId: targetListId };
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

  return (
    <section className="tp-card">
      <h2>{targetListName ? `Import into “${targetListName}”` : "Import contacts"}</h2>
      <p className="app-muted">
        {targetListName
          ? `Upload a CSV or XLSX, map its columns, validate, and we’ll dedupe and add the rows to “${targetListName}”.`
          : "Upload a CSV or XLSX, map its columns, validate, and we’ll dedupe into this workspace."}
      </p>

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
          <TpInput
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <label className="tp-field">
          <span>On duplicate</span>
          <TpSelect
            value={conflictPolicy}
            onChange={(e) => setConflictPolicy(e.target.value as ConflictPolicy)}
          >
            {CONFLICT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </TpSelect>
        </label>
      </div>

      {headers.length > 0 && templates.length > 0 && (
        <label className="tp-field">
          <span>Apply a saved template</span>
          <TpSelect
            value=""
            onChange={(e) => {
              if (e.target.value) onApplyTemplate(e.target.value);
            }}
          >
            <option value="">— choose a template —</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </TpSelect>
        </label>
      )}

      {headers.length > 0 && (
        <div className="tp-mapper">
          {GROUPS.map((group) => (
            <fieldset key={group} className="tp-group">
              <legend>{group}</legend>
              {MAPPABLE_FIELDS.filter((f: MappableField) => f.group === group).map((f) => (
                <label key={f.field} className="tp-field">
                  <span>{f.label}</span>
                  <TpSelect
                    value={mapping[f.field] ?? ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      setMapping((m) => ({ ...m, [f.field]: value }));
                      invalidatePreview();
                    }}
                  >
                    <option value="">— not mapped —</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </TpSelect>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}

      {headers.length > 0 && (
        <div className="tp-row">
          <label className="tp-field">
            <span>Save this mapping as a template</span>
            <TpInput
              type="text"
              placeholder="Template name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
            />
          </label>
          <TpButton
            variant="secondary"
            type="button"
            disabled={savingTemplate || !templateName.trim() || !identityMapped}
            onClick={() => void onSaveTemplate()}
          >
            {savingTemplate ? "Saving…" : "Save as template"}
          </TpButton>
        </div>
      )}

      {templateMsg && <p className="app-muted">{templateMsg}</p>}

      {!identityMapped && headers.length > 0 && (
        <p className="app-muted">
          Map at least one identity field (Email, LinkedIn, or Sales Nav id) to continue.
        </p>
      )}

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
