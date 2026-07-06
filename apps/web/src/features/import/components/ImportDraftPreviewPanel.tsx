// ImportDraftPreviewPanel.tsx — renders the S-I8 FULL-PASS draft projection (08 §4 / 11 §3-W3): the count
// band (total · valid · would-create · would-update · in-file duplicates · rejected), the typed-code
// histogram, per-column feedback (parse failures + sample LINE NUMBERS — never values), and the bounded
// (≤50) rejected-row samples. Richer than the legacy client preview, which stays the gate-off branch.
// Resume renders the row's CACHED summary (no samples persist — non-PII by construction) with a re-run
// affordance. Pure presentation; the hook owns the data.
"use client";

import type { ImportDraftPreviewResponse } from "@leadwolf/types";
import { StatTile, TpButton } from "@leadwolf/ui";

export function ImportDraftPreviewPanel({
  preview,
  cached,
  busy,
  onRerun,
}: {
  preview: ImportDraftPreviewResponse | null;
  /** True when `summary` is the row's cached preview_summary (resume) — samples need a fresh pass. */
  cached: boolean;
  busy: boolean;
  onRerun: () => void;
}) {
  if (!preview) {
    return (
      <div className="tp-summary">
        <p className="app-muted">No validation results yet — run validation to see what this import would do.</p>
        <TpButton variant="secondary" type="button" loading={busy} onClick={onRerun}>
          Validate file
        </TpButton>
      </div>
    );
  }

  const s = preview.summary;
  return (
    <div className="tp-summary">
      <strong>Validation preview.</strong>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
          gap: "var(--tp-space-2)",
          margin: "var(--tp-space-3) 0",
        }}
      >
        <StatTile label="Total rows" value={s.total.toLocaleString()} />
        <StatTile label="Valid" value={s.valid.toLocaleString()} />
        <StatTile label="Would create" value={s.wouldCreate.toLocaleString()} />
        <StatTile label="Would update" value={s.wouldUpdate.toLocaleString()} />
        <StatTile label="Duplicates in file" value={s.duplicateInFile.toLocaleString()} />
        <StatTile label="Rejected" value={s.rejected.toLocaleString()} />
      </div>

      {cached && (
        <p className="app-muted">
          Showing the validation saved with this draft. Re-run it to see row-level samples.{" "}
          <TpButton variant="secondary" type="button" loading={busy} onClick={onRerun}>
            Re-run validation
          </TpButton>
        </p>
      )}

      {Object.keys(s.rejectHistogram).length > 0 && (
        <div className="app-muted">
          <span>Why rows would be rejected:</span>
          <ul className="tp-errors">
            {Object.entries(s.rejectHistogram)
              .sort((a, b) => b[1] - a[1])
              .map(([code, count]) => (
                <li key={code}>
                  {code}: {count.toLocaleString()}
                </li>
              ))}
          </ul>
        </div>
      )}

      {s.perColumn.length > 0 && (
        <div className="app-muted">
          <span>Columns needing attention:</span>
          <ul className="tp-errors">
            {s.perColumn.map((c) => (
              <li key={c.column}>
                {c.column}: {c.parseFailures.toLocaleString()} value
                {c.parseFailures === 1 ? "" : "s"} couldn’t be read
                {c.dominantRejectCode ? ` (mostly ${c.dominantRejectCode})` : ""}
                {c.sampleLines.length > 0 ? ` — e.g. line ${c.sampleLines.slice(0, 5).join(", ")}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.sampleRejectedRows.length > 0 && (
        <div className="app-muted">
          <span>Sample rejected rows ({preview.sampleRejectedRows.length}):</span>
          {/* Bounded (≤50) and scrolled in its own container — the page never scrolls sideways/endlessly. */}
          <ul className="tp-errors" style={{ maxHeight: 240, overflowY: "auto" }}>
            {preview.sampleRejectedRows.map((r, i) => (
              // Two reasons can share a row, so the row index alone is not a unique key.
              <li key={`${r.row}-${r.field ?? "row"}-${i}`}>
                Row {r.row + 1}
                {r.field ? ` (${r.field})` : ""}: {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.rejected === 0 && <p className="app-muted">All rows passed validation.</p>}
    </div>
  );
}
