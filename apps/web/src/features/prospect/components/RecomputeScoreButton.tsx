// RecomputeScoreButton.tsx — the on-demand lead-score "Recompute" control for the record detail's Lead score
// section (W2). POSTs /contacts/:id/rescore (computeScore runs inline, fast — ADR-0008), then re-runs the
// parent's useScores reload so the freshly appended row shows. Local idle/pending/error action state; the
// score math + tenancy gate run server-side. Presentation only — never computes a score client-side.
"use client";

import { TpButton, useToast } from "@leadwolf/ui";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { rescoreContact } from "../api";

type ActionState = "idle" | "pending" | "error";

export function RecomputeScoreButton({
  contactId,
  onScored,
}: {
  contactId: string;
  /** Reuse the section's useScores reload so the newly computed score lands in the breakdown. */
  onScored: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [action, setAction] = useState<ActionState>("idle");

  const onClick = async () => {
    setAction("pending");
    try {
      await rescoreContact(contactId);
      await onScored();
      setAction("idle");
      toast.success("Score recomputed");
    } catch (e) {
      setAction("error");
      toast.error("Could not recompute", e instanceof Error ? e.message : undefined);
    }
  };

  return (
    <TpButton
      variant="ghost"
      size="sm"
      loading={action === "pending"}
      leftIcon={<RefreshCw size={14} />}
      onClick={onClick}
    >
      {action === "error" ? "Retry score" : "Recompute"}
    </TpButton>
  );
}
