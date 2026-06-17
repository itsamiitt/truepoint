// ImportWizard.tsx — the import surface: pick a source + CSV, map its columns to canonical fields, and run
// the import. Headers are read client-side only to populate the mapper's dropdowns (the server does the
// authoritative RFC-4180 parse + dedup in packages/core). A cohesive feature component; presentation +
// local view state only — the actual import runs server-side: useImport enqueues a background job and POLLS
// it to completion, surfacing a queued → processing → done/failed lifecycle (no summary until it settles).
"use client";

import type {
  CanonicalField,
  ColumnMapping,
  ImportMappingTemplate,
  SourceName,
} from "@leadwolf/types";
import { useEffect, useRef, useState } from "react";
import { listMappingTemplates, saveMappingTemplate } from "../api";
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
  const { status, jobId, summary, error, busy, run } = useImport();
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [sourceName, setSourceName] = useState<SourceName>("manual");
  const [mapping, setMapping] = useState<Partial<Record<CanonicalField, string>>>({});

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
      onImported();
    }
  }, [status, summary, onImported]);

  async function onFile(f: File | null): Promise<void> {
    setFile(f);
    setMapping({});
    setHeaders(f ? await readHeaders(f) : []);
  }

  const identityMapped = IDENTITY_FIELDS.some((f) => mapping[f]);
  const canSubmit = Boolean(file) && identityMapped && !busy;

  function onSubmit(): void {
    if (!file) return;
    notifiedRef.current = false;
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(mapping)) if (v) cleaned[k] = v;
    run({ file, sourceName, mapping: cleaned as ColumnMapping });
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

      {headers.length > 0 && templates.length > 0 && (
        <label className="lw-field">
          <span>Apply a saved template</span>
          <select
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
          </select>
        </label>
      )}

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

      {headers.length > 0 && (
        <div className="lw-row">
          <label className="lw-field">
            <span>Save this mapping as a template</span>
            <input
              type="text"
              placeholder="Template name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
            />
          </label>
          <button
            className="app-button"
            type="button"
            disabled={savingTemplate || !templateName.trim() || !identityMapped}
            onClick={() => void onSaveTemplate()}
          >
            {savingTemplate ? "Saving…" : "Save as template"}
          </button>
        </div>
      )}

      {templateMsg && <p className="app-muted">{templateMsg}</p>}

      {!identityMapped && headers.length > 0 && (
        <p className="app-muted">
          Map at least one identity field (Email, LinkedIn, or Sales Nav id) to continue.
        </p>
      )}

      <button className="app-button" type="button" disabled={!canSubmit} onClick={onSubmit}>
        {status === "submitting"
          ? "Uploading…"
          : status === "processing"
            ? "Processing…"
            : "Import"}
      </button>

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
          {summary.skipped} duplicate{summary.skipped === 1 ? "" : "s"} skipped
          {summary.errors.length > 0 && <> · {summary.errors.length} error(s)</>}
          {summary.errors.length > 0 && (
            <ul className="lw-errors">
              {summary.errors.slice(0, 5).map((e, i) => (
                // Two errors can share a row, so the row index alone is not a unique key.
                <li key={`${e.row}-${i}`}>
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
