// RefreshFromSourceButton.tsx — the one-click "Refresh from LinkedIn" trigger for a contact or an account
// (linkedin-source-ingestion §customer UI; the ReverifyNowButton single-shot posture).
//
// Contract handling, both branches of the shipped route:
//   200 (inline, ENRICHMENT_ASYNC_ENABLED off) → the data already changed: invalidate now.
//   202 {jobId} → poll nothing here; wait a beat and invalidate on a short delay ladder (2s/6s/15s) —
//     the job usually lands within seconds, and the sections' queries are cheap re-reads. A dedicated
//     job-status poller is deliberately NOT built into this button: the enrichment-jobs page already
//     exists for watching jobs; a footer button should stay a fire-and-refresh affordance.
//
// The button never disables on "no LinkedIn identity" client-side for CONTACTS — the waterfall still
// cascades to email-keyed vendors, so the click is useful either way. For ACCOUNTS the server 422s
// honestly and the message is surfaced as-is.
"use client";

import { TpButton, useToast } from "@leadwolf/ui";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { refreshAccountFromSource, refreshContactFromSource } from "../enrichApi";
import { prospectKeys } from "../keys";

const REFRESH_DELAYS_MS = [2_000, 6_000, 15_000];

export function RefreshFromSourceButton({
  entity,
  id,
}: {
  entity: "contact" | "account";
  id: string;
}) {
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Clear the delay ladder on unmount (perf-audit P3.8): the timers were never cleaned, so closing the
  // drawer kept firing up to 15 invalidations (5 keys × 3 ticks) for sections no longer on screen.
  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current = [];
    },
    [],
  );

  const invalidate = () => {
    if (entity === "contact") {
      void queryClient.invalidateQueries({ queryKey: prospectKeys.revealedContact(id) });
      void queryClient.invalidateQueries({ queryKey: prospectKeys.contactEmployment(id) });
      void queryClient.invalidateQueries({ queryKey: prospectKeys.contactEducation(id) });
      void queryClient.invalidateQueries({ queryKey: prospectKeys.contactAttributes(id) });
      void queryClient.invalidateQueries({ queryKey: prospectKeys.contactProvenance(id) });
    } else {
      void queryClient.invalidateQueries({ queryKey: prospectKeys.accountHeadcount(id) });
      void queryClient.invalidateQueries({
        queryKey: prospectKeys.accountTechnologies(id, "uses"),
      });
      void queryClient.invalidateQueries({
        queryKey: prospectKeys.accountTechnologies(id, "develops"),
      });
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const result =
        entity === "contact"
          ? await refreshContactFromSource(id)
          : await refreshAccountFromSource(id);
      if (result.queued) {
        toast.success("Refresh queued — data updates shortly");
        // Delay ladder instead of a poller: cheap re-reads at the moments the job most likely landed.
        for (const delay of REFRESH_DELAYS_MS) {
          timers.current.push(setTimeout(invalidate, delay));
        }
      } else {
        toast.success("Refreshed");
        invalidate();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <TpButton
      variant="ghost"
      size="sm"
      leftIcon={<RefreshCw size={15} />}
      onClick={() => void run()}
      disabled={busy}
    >
      {busy ? "Refreshing…" : entity === "contact" ? "Refresh contact" : "Refresh company"}
    </TpButton>
  );
}
