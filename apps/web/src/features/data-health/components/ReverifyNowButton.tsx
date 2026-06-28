// ReverifyNowButton.tsx — the owner/admin-only "Re-verify now" trigger on the Re-verification activity tab
// (data-management #3 follow-up). Runs the SAME bounded, idempotent per-workspace re-verification the daily sweep
// runs, on demand. Gated to owner/admin (canTrigger → renders nothing otherwise). A confirm Dialog states the
// HONEST cost note — it re-checks already-revealed, past-SLA contacts and refreshes their verification status; it
// does NOT spend reveal credits, and only does work if re-verification is enabled for the org — before the POST.
// Handles 429 (rate-limited) and 403 (not allowed) gracefully via toast. @leadwolf/ui only; tokens only.
"use client";

import { Dialog, TpButton, useToast } from "@leadwolf/ui";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { triggerReverification } from "../api";
import styles from "../data-health.module.css";

export function ReverifyNowButton({
  canTrigger,
  onQueued,
}: {
  canTrigger: boolean;
  onQueued: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // UI gate (defense-in-depth; the endpoint also enforces requireRole). Non-admins never see the action.
  if (!canTrigger) return null;

  async function onConfirm(): Promise<void> {
    setBusy(true);
    try {
      const res = await triggerReverification();
      if (res.ok) {
        setOpen(false);
        toast.success("Re-verification queued", "Results appear here as runs complete.");
        onQueued();
        return;
      }
      if (res.reason === "rate_limited") {
        toast.error("Try again shortly", res.message);
        return;
      }
      setOpen(false);
      toast.error(
        res.reason === "forbidden" ? "Not allowed" : "Couldn't start re-verification",
        res.message,
      );
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      <TpButton variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
        Cancel
      </TpButton>
      <TpButton onClick={() => void onConfirm()} loading={busy}>
        Re-verify now
      </TpButton>
    </>
  );

  return (
    <>
      <div className={styles.activityActions}>
        <TpButton
          variant="secondary"
          size="sm"
          leftIcon={<RefreshCw size={14} />}
          onClick={() => setOpen(true)}
        >
          Re-verify now
        </TpButton>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Re-verify stale contacts now"
        footer={footer}
        maxWidth={440}
      >
        <p className={styles.footnote}>
          This re-checks your already-revealed contacts whose data has passed its freshness SLA and
          refreshes their verification status — the same bounded daily sweep, run on demand. It does
          not spend your reveal credits, and only does work if re-verification is enabled for your
          organization.
        </p>
      </Dialog>
    </>
  );
}
