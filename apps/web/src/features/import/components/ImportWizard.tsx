// ImportWizard.tsx — the import surface: pick a source + CSV, map its columns to canonical fields, and run
// the import. Headers are read client-side only to populate the mapper's dropdowns (the server does the
// authoritative RFC-4180 parse + dedup in packages/core). A cohesive feature component; presentation +
// local view state only — the actual import runs server-side via useImport → api.postImport.
"use client";

import type { CanonicalField, ColumnMapping, SourceName } from "@leadwolf/types";
import { useState } from "react";
import { useImport } from "../hooks/useImport";
import { IDENTITY_FIELDS, MAPPABLE_FIELDS, type MappableField, SOURCE_OPTIONS } from "../types";

const GROUPS = ["Identity", "Person", "Company", "Location"] as const;

async function readHeaders(file: File): Promise<string[]> {
  const firstLine = (await file.text()).split(/\r?\n/)[0] ?? "";
  return firstLine
    .split(",")
    .map((h) => h.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

export function ImportWizard({ onImported }: { onImported: () => void }) {
  const { summary, error, busy, run } = useImport();
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [sourceName, setSourceName] = useState<SourceName>("manual");
  const [mapping, setMapping] = useState<Partial<Record<CanonicalField, string>>>({});

  async function onFile(f: File | null): Promise<void> {
    setFile(f);
    setMapping({});
    setHeaders(f ? await readHeaders(f) : []);
  }

  const identityMapped = IDENTITY_FIELDS.some((f) => mapping[f]);
  const canSubmit = Boolean(file) && identityMapped && !busy;

  async function onSubmit(): Promise<void> {
    if (!file) return;
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapping)) if (v) cleaned[k] = v;
    const result = await run({ file, sourceName, mapping: cleaned as ColumnMapping });
    if (result) onImported();
  }

  return (
    <section className="lw-card">
      <h2>Import contacts</h2>
      <p className="app-muted">
        Upload a CSV, map its columns, and we&apos;ll dedupe into this workspace.
      </p>

      <div className="lw-row">
        <label className="lw-field">
          <span>Source</span>
          <select value={sourceName} onChange={(e) => setSourceName(e.target.value as SourceName)}>
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
                    onChange={(e) => setMapping((m) => ({ ...m, [f.field]: e.target.value }))}
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

      <button
        className="app-button"
        type="button"
        disabled={!canSubmit}
        onClick={() => void onSubmit()}
      >
        {busy ? "Importing…" : "Import"}
      </button>

      {error && <p className="lw-error">{error}</p>}
      {summary && (
        <div className="lw-summary">
          <strong>Import complete.</strong> {summary.created} new · {summary.matched} matched ·{" "}
          {summary.skipped} duplicate{summary.skipped === 1 ? "" : "s"} skipped
          {summary.errors.length > 0 && <> · {summary.errors.length} error(s)</>}
          {summary.errors.length > 0 && (
            <ul className="lw-errors">
              {summary.errors.slice(0, 5).map((e) => (
                <li key={e.row}>
                  Row {e.row + 1}: {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
