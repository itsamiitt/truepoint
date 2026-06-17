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
  ImportPreview,
  SourceName,
} from "@leadwolf/types";
import { useEffect, useRef, useState } from "react";
import { postImportPreview } from "../api";
import { useImport } from "../hooks/useImport";
import { rejectedRowsToCsv } from "../rejectedRowsCsv";
import { IDENTITY_FIELDS, MAPPABLE_FIELDS, type MappableField, SOURCE_OPTIONS } from "../types";

const GROUPS = ["Identity", "Person", "Company", "Location"] as const;

const CONFLICT_OPTIONS: { value: ConflictPolicy; label: string }[] = [
  { value: "skip", label: "Skip — keep existing contact (no overwrite)" },
  { value: "overwrite", label: "Overwrite — update existing contact" },
  { value: "keep_both", label: "Keep both — new rows added; existing matches kept as-is" },
];

async function readHeaders(file: File): Promise<string[]> {
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

export function ImportWizard({ onImported }: { onImported: () => void }) {
  const { status, jobId, summary, error, busy, run } = useImport();
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [sourceName, setSourceName] = useState<SourceName>("manual");
  const [mapping, setMapping] = useState<Partial<Record<CanonicalField, string>>>({});
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>("skip");

  // Pre-commit validation preview (G-IMP-1): the user validates first, then confirms to run the real import.
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Notify the parent exactly once per completed import (the job settles asynchronously via polling, so this
  // can't be done inline in onSubmit). The ref guards against re-firing on unrelated re-renders.
  const notifiedRef = useRef(false);
  useEffect(() => {
    if (status === "done" && summary && !notifiedRef.current) {
      notifiedRef.current = true;
      onImported();
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
  const canValidate = Boolean(file) && identityMapped && !previewBusy && !busy;
  const canSubmit = Boolean(file) && identityMapped && preview !== null && !busy;

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
    notifiedRef.current = false;
    run({ file, sourceName, mapping: cleanedMapping(), conflictPolicy });
  }

  function onDownloadRejected(): void {
    if (!summary || summary.rejectedRows.length === 0) return;
    const base = (file?.name ?? "import").replace(/\.csv$/i, "");
    downloadCsv(rejectedRowsToCsv(summary.rejectedRows), `${base}-rejected.csv`);
  }

  return (
    <section className="lw-card">
      <h2>Import contacts</h2>
      <p className="app-muted">
        Upload a CSV, map its columns, validate, and we&apos;ll dedupe into this workspace.
      </p>

      <div className="lw-row">
        <label className="lw-field">
          <span>Source</span>
          <select
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
          </select>
        </label>
        <label className="lw-field">
          <span>CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <label className="lw-field">
          <span>On duplicate</span>
          <select
            value={conflictPolicy}
            onChange={(e) => setConflictPolicy(e.target.value as ConflictPolicy)}
          >
            {CONFLICT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {headers.length > 0 && (
        <div className="lw-mapper">
          {GROUPS.map((group) => (
            <fieldset key={group} className="lw-group">
              <legend>{group}</legend>
              {MAPPABLE_FIELDS.filter((f: MappableField) => f.group === group).map((f) => (
                <label key={f.field} className="lw-field">
                  <span>{f.label}</span>
                  <select
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
                  </select>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}

      {!identityMapped && headers.length > 0 && (
        <p className="app-muted">
          Map at least one identity field (Email, LinkedIn, or Sales Nav id) to continue.
        </p>
      )}

      <div className="lw-row">
        <button
          className="app-button"
          type="button"
          disabled={!canValidate}
          onClick={() => void onValidate()}
        >
          {previewBusy ? "Validating…" : "Validate"}
        </button>
        <button className="app-button" type="button" disabled={!canSubmit} onClick={onSubmit}>
          {status === "submitting"
            ? "Uploading…"
            : status === "processing"
              ? "Processing…"
              : "Confirm & import"}
        </button>
      </div>

      {previewError && <p className="lw-error">{previewError}</p>}

      {preview && status !== "done" && (
        <div className="lw-summary">
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
                <ul className="lw-errors">
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

      {error && <p className="lw-error">{error}</p>}

      {status === "done" && summary && (
        <div className="lw-summary">
          <strong>Import complete.</strong> {summary.created} new · {summary.matched} matched ·{" "}
          {summary.duplicates} duplicate{summary.duplicates === 1 ? "" : "s"} · {summary.skipped}{" "}
          skipped
          {summary.rejected > 0 && <> · {summary.rejected} rejected</>}
          {summary.rejectedRows.length > 0 && (
            <p>
              <button className="app-button" type="button" onClick={onDownloadRejected}>
                Download rejected rows ({summary.rejected})
              </button>
            </p>
          )}
          {summary.rejectedRows.length > 0 && (
            <ul className="lw-errors">
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
