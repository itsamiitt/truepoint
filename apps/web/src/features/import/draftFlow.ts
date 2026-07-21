// draftFlow.ts — the PURE state machine behind the S-U7 draft-backed wizard (import-redesign 11 §3, S-I8
// client half). No React, no fetch: step vocabulary, deep-link parsing/clamping, resume coercion, the
// server-proposal filter, and the preview-step gating live here so useImportDraft stays a thin controller
// and the transitions are unit-testable without a DOM (the CI-owed component tests run against this module).
// The draft steps exist ONLY while a server draft backs the wizard — gate-off keeps today's single-card
// one-shot layout byte-identical (the canary rule), so "upload" is not a step here: no draft, no steps.

import type { CanonicalField, ColumnMapping, ImportPreviewSummary } from "@leadwolf/types";
import { MAPPABLE_FIELDS } from "./types";

/** The draft-mode wizard steps, in order. `?step=` carries exactly these values (11 §3's deep-link). */
export const DRAFT_STEPS = ["map", "preview", "confirm"] as const;
export type DraftStep = (typeof DRAFT_STEPS)[number];

/** Parse a `?step=` search param. Unknown/absent values are null — the caller falls back to the default
 *  entry step, never an error state (a stale deep-link must not break the wizard). */
export function parseStepParam(raw: string | null | undefined): DraftStep | null {
  return (DRAFT_STEPS as readonly string[]).includes(raw ?? "") ? (raw as DraftStep) : null;
}

export function stepIndex(step: DraftStep): number {
  return DRAFT_STEPS.indexOf(step);
}

/** The step heading (also the focus target on step change — 11 §7.2). */
export function stepHeading(step: DraftStep): string {
  switch (step) {
    case "map":
      return "Map columns";
    case "preview":
      return "Validation preview";
    case "confirm":
      return "Review & run";
  }
}

/** What the flow has already accomplished — the facts step gating runs on. */
export interface DraftFlowFacts {
  /** A mapping document has been PUT to the draft (this session or a prior one — resume implies it). */
  mappingSaved: boolean;
  /** A preview projection is in hand (fresh POST /preview or the row's cached preview_summary). */
  previewed: boolean;
}

/** Whether a step may be ENTERED given the facts. Deep-links and Back/Continue both run through this:
 *  preview requires a saved mapping (the server 422s otherwise), confirm requires a seen projection
 *  (the user must confirm what will happen — G-IMP-1's posture carried into the draft flow). */
export function canEnterStep(step: DraftStep, facts: DraftFlowFacts): boolean {
  if (step === "map") return true;
  if (step === "preview") return facts.mappingSaved;
  return facts.mappingSaved && facts.previewed;
}

/** Clamp a requested step (deep-link / back-forward) to the deepest ENTERABLE step at or before it. */
export function clampStep(requested: DraftStep, facts: DraftFlowFacts): DraftStep {
  for (let i = stepIndex(requested); i > 0; i--) {
    const step = DRAFT_STEPS[i] as DraftStep;
    if (canEnterStep(step, facts)) return step;
  }
  return "map";
}

/** Resume (`?draft=<id>`) coercion: no shipped read DTO exposes the draft's headers or saved mapping
 *  (the draft ref carries them at CREATE only; `GET /imports/:id` = ImportJobDetailV2 — strategy +
 *  cached preview_summary, no columns), so the mapping GRID cannot re-render on resume. A resumed draft
 *  re-enters at preview/confirm — the server holds the saved mapping, and preview/commit work without
 *  the client ever knowing it. A `?step=map` deep-link on resume coerces to preview (honest copy in the
 *  flow explains the discard-and-reupload path for mapping edits). Drift-logged in doc 16. */
export function coerceResumeStep(requested: DraftStep | null, facts: DraftFlowFacts): DraftStep {
  const wanted = requested == null || requested === "map" ? "preview" : requested;
  return clampStep(wanted, facts);
}

/** Keep only the fields the wizard renders a control for — the same discipline as applying a saved
 *  template (an automation-created proposal must never inject hidden, un-editable mapping state). The
 *  server's auto-map proposal (draft ref `suggestedMapping`) runs through this before it becomes the
 *  wizard's mapping state; the client-side autoMapHeaders is the gate-off fallback only. */
export function filterMappingToMappable(mapping: ColumnMapping): Partial<Record<CanonicalField, string>> {
  const next: Partial<Record<CanonicalField, string>> = {};
  for (const mf of MAPPABLE_FIELDS) {
    const header = mapping[mf.field];
    if (header) next[mf.field] = header;
  }
  return next;
}

/** The preview step's Continue label — honest about skips (11 §3-W3). */
export function previewContinueLabel(summary: ImportPreviewSummary | null): string {
  if (!summary || summary.rejected === 0) return "Continue";
  return `Continue — ${summary.rejected.toLocaleString()} row${summary.rejected === 1 ? "" : "s"} will be skipped`;
}

/** A 100%-rejected preview blocks the flow with guidance instead of letting a no-op import run (11 §3-W3). */
export function previewBlocked(summary: ImportPreviewSummary | null): boolean {
  return summary != null && summary.total > 0 && summary.valid === 0;
}

/** The gate-probe verdict → whether the draft path engages. The probe is `GET /imports?state=draft`
 *  (404 ⇒ the IMPORT_V2 dual gate is off — the list endpoint is the no-existence-oracle 404, S-I4).
 *  Gate-off AND any probe failure both fall back silently to today's client-side one-shot flow — the
 *  canary rule: the draft path may only ever ADD, never block an import. */
export function draftPathFromProbe(outcome: "enabled" | "not-enabled" | "error"): boolean {
  return outcome === "enabled";
}
