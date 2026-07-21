// ConfirmDialog.tsx — the shared destructive/confirm modal for import mutations (design skill: mutations are a
// Dialog with an explanation, never a toast-only action). The DS `Dialog` is a generic shell — it carries no
// confirm/cancel affordance — so we compose the footer buttons here. `busy` disables both while the mutation
// is in flight; `destructive` styles the confirm as the danger variant.
"use client";

import { Dialog, TpButton } from "@leadwolf/ui";
import type { ReactNode } from "react";

export function ConfirmDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  cancelLabel = "Keep it",
  destructive = false,
  busy = false,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      maxWidth={460}
      footer={
        <div
          style={{
            display: "flex",
            gap: "var(--tp-space-2)",
            justifyContent: "flex-end",
          }}
        >
          <TpButton variant="ghost" type="button" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </TpButton>
          <TpButton
            variant={destructive ? "danger" : "primary"}
            type="button"
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </TpButton>
        </div>
      }
    >
      {typeof body === "string" ? (
        <p style={{ margin: 0, color: "var(--tp-ink-2)", lineHeight: 1.5 }}>{body}</p>
      ) : (
        body
      )}
    </Dialog>
  );
}
