// BulkRevealJobDialog.tsx — the ASYNC bulk-reveal flow (Phase 3), used when the user selects ALL matching
// results (the synchronous client loop can't do that). On open it creates a job (server-resolves the criteria
// to visible ids + sizes the worst-case estimate — spends nothing); the user confirms (leases the ceiling +
// starts a worker run); a live progress bar polls the job; on completion a revealed CSV is downloadable. While
// the feature is dark (BULK_REVEAL_ENABLED off) confirm returns 403 and we degrade gracefully.
"use client";

import type { ContactQuery, RevealJobEstimate, RevealType } from "@leadwolf/types";
import { Dialog, Progress, TpButton, useToast } from "@leadwolf/ui";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  cancelBulkRevealJob,
  confirmBulkRevealJob,
  createBulkRevealJob,
  fetchBulkRevealDownloadUrl,
} from "../api";
import { useRevealJob } from "../hooks/useRevealJob";
import styles from "../prospect.module.css";

type Phase = "loading" | "estimate" | "running" | "error" | "disabled";

export function BulkRevealJobDialog({
  open,
  onClose,
  criteria,
  revealType = "full_profile",
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** The active search query — the job reveals every VISIBLE contact matching it (resolved server-side). */
  criteria: ContactQuery;
  revealType?: RevealType;
  /** Called after a run finishes so the parent can refresh the grid + clear the selection. */
  onDone?: () => void;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("loading");
  const [estimate, setEstimate] = useState<RevealJobEstimate | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null); // set once confirmed → starts polling
  const [confirming, setConfirming] = useState(false);
  const { job } = useRevealJob(activeJobId);

  // On open: create the job (arms the confirm gate; no spend) and show the estimate.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPhase("loading");
    setEstimate(null);
    setMessage(null);
    setJobId(null);
    setActiveJobId(null);
    createBulkRevealJob({ revealType, criteria })
      .then((est) => {
        if (!live) return;
        setEstimate(est);
        setJobId(est.jobId);
        setPhase("estimate");
      })
      .catch((e) => {
        if (!live) return;
        setMessage(e instanceof Error ? e.message : "Could not prepare the bulk reveal.");
        setPhase("error");
      });
    return () => {
      live = false;
    };
  }, [open, criteria, revealType]);

  const onConfirm = useCallback(async () => {
    if (!jobId) return;
    setConfirming(true);
    try {
      await confirmBulkRevealJob(jobId);
      setActiveJobId(jobId); // begin polling progress
      setPhase("running");
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setMessage(
          "Bulk reveal across all matching results is rolling out. For now, select specific rows.",
        );
        setPhase("disabled");
      } else if (e instanceof ApiError && e.code === "insufficient_credits") {
        setMessage(e.message);
        setPhase("estimate");
      } else {
        setMessage(e instanceof Error ? e.message : "Could not start the reveal.");
        setPhase("error");
      }
    } finally {
      setConfirming(false);
    }
  }, [jobId]);

  const onDownload = useCallback(async () => {
    if (!jobId) return;
    try {
      const url = await fetchBulkRevealDownloadUrl(jobId);
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error("Download not ready", e instanceof Error ? e.message : undefined);
    }
  }, [jobId, toast]);

  const onCancel = useCallback(async () => {
    if (!jobId) return;
    try {
      await cancelBulkRevealJob(jobId);
      toast.toast({ title: "Reveal cancelled", description: "Unspent credits were released." });
    } catch {
      /* best-effort */
    }
  }, [jobId, toast]);

  const terminal =
    job && (job.status === "completed" || job.status === "failed" || job.status === "cancelled");
  const busy = phase === "loading" || confirming || (phase === "running" && !terminal);

  const close = () => {
    if (!busy) {
      if (terminal) onDone?.();
      onClose();
    }
  };

  const footer =
    phase === "estimate" ? (
      <>
        <TpButton variant="ghost" onClick={close} disabled={confirming}>
          Cancel
        </TpButton>
        <TpButton
          onClick={() => void onConfirm()}
          loading={confirming}
          disabled={!estimate || estimate.totalContacts === 0}
        >
          Reveal {estimate?.totalContacts?.toLocaleString() ?? ""}
        </TpButton>
      </>
    ) : phase === "running" && terminal ? (
      <>
        {job?.status === "completed" && job.revealedContacts > 0 ? (
          <TpButton variant="ghost" onClick={() => void onDownload()}>
            Download CSV
          </TpButton>
        ) : null}
        <TpButton onClick={close}>Done</TpButton>
      </>
    ) : phase === "running" ? (
      <TpButton variant="ghost" onClick={() => void onCancel()}>
        Cancel run
      </TpButton>
    ) : (
      <TpButton variant="secondary" onClick={close}>
        Close
      </TpButton>
    );

  return (
    <Dialog open={open} onClose={close} title="Reveal all matching" footer={footer} maxWidth={460}>
      {phase === "loading" && <p className={styles.revealMeta}>Preparing the reveal…</p>}

      {phase === "estimate" && estimate && (
        <>
          <p className={styles.dialogNote}>
            Reveals the full profile for <strong>{estimate.totalContacts.toLocaleString()}</strong>{" "}
            matching contact{estimate.totalContacts === 1 ? "" : "s"}. Runs in the background; you
            only pay for valid data. Already-owned contacts are free.
          </p>
          <p className={styles.revealMeta}>
            Costs up to{" "}
            <strong>
              {estimate.projectedMaxCredits.toLocaleString()} credit
              {estimate.projectedMaxCredits === 1 ? "" : "s"}
            </strong>{" "}
            ({estimate.billableContacts.toLocaleString()} billable
            {estimate.alreadyOwnedContacts > 0
              ? `, ${estimate.alreadyOwnedContacts.toLocaleString()} already owned`
              : ""}
            ). Balance <strong>{estimate.balance.toLocaleString()}</strong> →{" "}
            <strong>{estimate.balanceAfter.toLocaleString()}</strong> after.
          </p>
          {(!estimate.sufficient || message) && (
            <div className={styles.inlineAlert}>
              <p className={styles.inlineAlertMsg}>
                {message ?? "Not enough credits to reveal all of them — top up, or select fewer."}
              </p>
              <Link className={styles.topupLink} href="/settings/billing">
                Top up credits →
              </Link>
            </div>
          )}
        </>
      )}

      {phase === "running" && job && (
        <>
          <Progress
            value={job.processedContacts}
            max={Math.max(1, job.totalContacts)}
            label={`Revealed ${job.processedContacts} of ${job.totalContacts}`}
          />
          <p className={styles.revealMeta}>
            {terminal ? (
              <>
                {job.status === "completed"
                  ? "Done"
                  : job.status === "cancelled"
                    ? "Cancelled"
                    : "Failed"}
                {" — "}
                revealed <strong>{job.revealedContacts.toLocaleString()}</strong>, already owned{" "}
                {job.alreadyOwnedContacts.toLocaleString()}, charged{" "}
                {job.creditSpent.toLocaleString()} credit{job.creditSpent === 1 ? "" : "s"}.
                {job.suppressedContacts > 0
                  ? ` Skipped ${job.suppressedContacts.toLocaleString()} suppressed.`
                  : ""}
                {job.failedContacts > 0
                  ? ` ${job.failedContacts.toLocaleString()} failed — retry those from the record view.`
                  : ""}
              </>
            ) : (
              <>
                Revealing in the background… {job.processedContacts.toLocaleString()} of{" "}
                {job.totalContacts.toLocaleString()}. You can close this — it keeps running.
              </>
            )}
          </p>
        </>
      )}

      {(phase === "error" || phase === "disabled") && (
        <p className={styles.dialogNote}>{message ?? "Something went wrong."}</p>
      )}
    </Dialog>
  );
}
