// useImportDraft.ts — the S-U7 draft-flow controller (import-redesign 11 §3 over the shipped S-I8 verbs).
// Owns the draft-backed wizard's SERVER state + step transitions: gate-probe → upload-once draft create →
// PUT mapping on step-advance → full-pass preview → idempotent commit → hand-off; plus `?draft=` resume and
// cancel-as-discard. The pure transition rules live in ../draftFlow.ts (unit-tested there); this file is the
// thin React/fetch shell. CANARY RULE: every failure to ENTER the draft path (gate off, probe error) falls
// back silently to today's client-side one-shot flow — the draft path may only ever add, never block.
"use client";

import { useQueryClient } from "@tanstack/react-query";
import type {
  ColumnMapping,
  ImportDraftPreviewResponse,
  ImportDraftRef,
  ImportMergeMode,
  SourceName,
} from "@leadwolf/types";
import { useEffect, useRef, useState } from "react";
import { commitDraft, fetchImportDrafts, postDraftPreview, postImportDraft, putDraftMapping } from "../apiDrafts";
import { cancelImportJob, fetchImportJobDetail } from "../apiV2";
import { clampStep, coerceResumeStep, type DraftStep } from "../draftFlow";
import { importKeys } from "../keys";

/** What `?draft=` resume restores from `GET /imports/:id` (ImportJobDetailV2): identity, filename, the 08 §5
 *  strategy, and the cached preview_summary. NOT restorable: headers + the saved mapping (no read DTO carries
 *  them — see draftFlow.coerceResumeStep; drift-logged in doc 16). */
export interface ResumedDraft {
  jobId: string;
  sourceFilename: string | null;
  mergeMode: ImportMergeMode | null;
  preservePopulated: boolean | null;
}

export interface DraftUrlState {
  step: DraftStep;
  draftId: string;
}

type DraftBusy = "create" | "advance" | "preview" | "commit" | "discard" | null;

export interface UseImportDraftOptions {
  /** The draft path engages only in the hand-off flow (onStarted present — the /imports/new page). The
   *  "import into list" dialog keeps the one-shot inline flow even gate-on (its receipt reads in place). */
  active: boolean;
  /** `?draft=` deep-link: resume this draft on mount. Absent/foreign/gate-off ⇒ silent fresh wizard. */
  resumeDraftId?: string | null;
  /** `?step=` deep-link (already parsed by the page). */
  initialStep?: DraftStep | null;
  /** URL sync: called on every step/draft transition (null = left draft mode). The page mirrors it via
   *  history.replaceState (the BillingPage pattern — no useSearchParams Suspense constraint). */
  onUrlChange?: (state: DraftUrlState | null) => void;
  /** Resume found the draft committed meanwhile — the caller navigates to the durable job page. */
  onResumedCommitted?: (jobId: string) => void;
}

export function useImportDraft(opts: UseImportDraftOptions) {
  const qc = useQueryClient();
  const [ref, setRef] = useState<ImportDraftRef | null>(null);
  const [resume, setResume] = useState<ResumedDraft | null>(null);
  const [step, setStep] = useState<DraftStep | null>(null);
  const [preview, setPreview] = useState<ImportDraftPreviewResponse | null>(null);
  const [previewIsCached, setPreviewIsCached] = useState(false);
  const [mappingSaved, setMappingSaved] = useState(false);
  const [busy, setBusy] = useState<DraftBusy>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [resumeNote, setResumeNote] = useState<string | null>(null);
  // One Idempotency-Key per draft (kept for the draft's lifetime) — a double-fired commit replays the same 202.
  const commitKeyRef = useRef<string | null>(null);
  // Mount-time options via a ref so the resume effect's deps stay honest (the values are read once per draft id).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const jobId = ref?.jobId ?? resume?.jobId ?? null;

  function syncUrl(next: { step: DraftStep; draftId: string } | null): void {
    optsRef.current.onUrlChange?.(next);
  }

  function clearDraftState(): void {
    setRef(null);
    setResume(null);
    setStep(null);
    setPreview(null);
    setPreviewIsCached(false);
    setMappingSaved(false);
    commitKeyRef.current = null;
    syncUrl(null);
  }

  /** Gate-on-TRY the draft path for a freshly picked file. Returns the draft ref when the wizard is now
   *  draft-backed; null ⇒ fall back to the client-side flow (gate off / probe failure = SILENT; a gate-on
   *  refusal like file_too_large surfaces via flowError AND falls back, so the user is never blocked —
   *  the one-shot path re-refuses with the same honest message at submit). */
  async function tryCreateDraft(
    file: File,
    sourceName: SourceName,
    listId?: string,
  ): Promise<ImportDraftRef | null> {
    if (!optsRef.current.active) return null;
    try {
      // The gate probe: GET /imports?state=draft (404 gate-off). Cached 60 s; dedupes with useImportDrafts.
      await qc.fetchQuery({
        queryKey: importKeys.drafts(),
        queryFn: () => fetchImportDrafts(),
        staleTime: 60_000,
        retry: false, // gate-off is a terminal 404 — one probe, never a retry storm
      });
    } catch {
      return null; // gate off (or probe blip) ⇒ today's flow, silently — the canary rule
    }
    setBusy("create");
    setFlowError(null);
    try {
      const created = await postImportDraft({ file, sourceName, listId });
      commitKeyRef.current = crypto.randomUUID();
      setRef(created);
      setResume(null);
      setResumeNote(null);
      setPreview(null);
      setPreviewIsCached(false);
      setMappingSaved(false);
      setStep("map");
      syncUrl({ step: "map", draftId: created.jobId });
      void qc.invalidateQueries({ queryKey: importKeys.drafts() });
      return created;
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : "Could not upload the file.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** Map → preview advance: PUT the mapping document (one write per Continue — on-step-advance, chosen for
   *  simplicity per 11 §3), then run the full-pass preview. */
  async function advanceFromMap(body: {
    mapping: ColumnMapping;
    templateId?: string;
    mergeMode: ImportMergeMode;
    preservePopulated: boolean;
  }): Promise<void> {
    if (!ref) return;
    setBusy("advance");
    setFlowError(null);
    try {
      await putDraftMapping(ref.jobId, body);
      setMappingSaved(true);
      const p = await postDraftPreview(ref.jobId);
      setPreview(p);
      setPreviewIsCached(false);
      setStep("preview");
      syncUrl({ step: "preview", draftId: ref.jobId });
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : "Could not validate the file.");
    } finally {
      setBusy(null);
    }
  }

  /** Re-run the projection (resume renders the cached summary first — samples need a fresh pass). */
  async function rerunPreview(): Promise<void> {
    if (!jobId) return;
    setBusy("preview");
    setFlowError(null);
    try {
      const p = await postDraftPreview(jobId);
      setPreview(p);
      setPreviewIsCached(false);
      setMappingSaved(true);
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : "Could not validate the file.");
    } finally {
      setBusy(null);
    }
  }

  /** Back/Continue between already-earned steps (deep-link-safe: clamped by the flow facts; a resumed
   *  draft never re-enters `map` — its headers/mapping are not client-restorable). */
  function goToStep(requested: DraftStep): void {
    if (!jobId) return;
    let target = clampStep(requested, { mappingSaved, previewed: preview != null });
    if (resume && target === "map") target = "preview";
    setStep(target);
    syncUrl({ step: target, draftId: jobId });
  }

  /** Commit the draft (Idempotency-Key minted once per draft). Returns the jobId for the S-U3 hand-off. */
  async function commit(): Promise<string | null> {
    if (!jobId) return null;
    commitKeyRef.current ??= crypto.randomUUID();
    setBusy("commit");
    setFlowError(null);
    try {
      const r = await commitDraft(jobId, commitKeyRef.current);
      void qc.invalidateQueries({ queryKey: importKeys.all });
      return r.jobId;
    } catch (e) {
      setFlowError(e instanceof Error ? e.message : "Could not start the import.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** Cancel-from-draft ≡ discard (08 §2.2). `silent` = best-effort (the replace-file path: a failed cancel
   *  leaves an orphan draft the 48 h reaper collects); otherwise a failure surfaces and state is kept. */
  async function discard(opts2?: { silent?: boolean }): Promise<boolean> {
    if (!jobId) return true;
    setBusy("discard");
    setFlowError(null);
    try {
      await cancelImportJob(jobId);
    } catch (e) {
      if (!opts2?.silent) {
        setFlowError(e instanceof Error ? e.message : "Could not discard the draft.");
        setBusy(null);
        return false;
      }
    }
    setBusy(null);
    clearDraftState();
    void qc.invalidateQueries({ queryKey: importKeys.drafts() });
    return true;
  }

  // `?draft=` resume: fetch the durable detail once per requested id. Only a gate-on `draft` row resumes;
  // committed-non-cancelled ⇒ the job page owns it; cancelled/legacy/absent ⇒ silent fresh wizard (+note).
  const resumeRequested = opts.active ? (opts.resumeDraftId ?? null) : null;
  useEffect(() => {
    if (!resumeRequested) return;
    let stale = false;
    void (async () => {
      try {
        const detail = await fetchImportJobDetail(resumeRequested);
        if (stale) return;
        if (detail.statusV2 === "draft") {
          const summary = detail.previewSummary ?? null;
          setResume({
            jobId: resumeRequested,
            sourceFilename: detail.sourceFilename ?? null,
            mergeMode: detail.mergeMode ?? null,
            preservePopulated: detail.preservePopulated ?? null,
          });
          // The mapping's existence isn't readable — assume saved (the common case); a mapping-less draft's
          // preview answers the honest 422 ("Save a column mapping…"), rendered with a Discard action.
          setMappingSaved(true);
          if (summary) {
            setPreview({ summary, sampleRejectedRows: [] });
            setPreviewIsCached(true);
          }
          commitKeyRef.current = crypto.randomUUID();
          const entry = coerceResumeStep(optsRef.current.initialStep ?? null, {
            mappingSaved: true,
            previewed: summary != null,
          });
          setStep(entry);
          optsRef.current.onUrlChange?.({ step: entry, draftId: resumeRequested });
        } else if (detail.statusV2 != null && detail.statusV2 !== "cancelled") {
          optsRef.current.onResumedCommitted?.(resumeRequested); // committed (or already done) — job page
        } else if (detail.statusV2 === "cancelled") {
          setResumeNote("That draft was discarded — start a new import below.");
          optsRef.current.onUrlChange?.(null);
        } else {
          optsRef.current.onUrlChange?.(null); // legacy shape (gate off): fresh wizard, silently
        }
      } catch {
        if (!stale) optsRef.current.onUrlChange?.(null); // absent/foreign/404 — no existence oracle to relay
      }
    })();
    return () => {
      stale = true;
    };
  }, [resumeRequested]);

  return {
    /** True while a server draft backs the wizard (steps render; upload-once holds). */
    inDraftMode: step != null,
    isResume: resume != null,
    jobId,
    ref,
    resume,
    step,
    preview,
    previewIsCached,
    mappingSaved,
    busy,
    flowError,
    resumeNote,
    clearFlowError: () => setFlowError(null),
    tryCreateDraft,
    advanceFromMap,
    rerunPreview,
    goToStep,
    commit,
    discard,
  };
}

export type ImportDraftController = ReturnType<typeof useImportDraft>;
