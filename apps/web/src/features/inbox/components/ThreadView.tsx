// ThreadView.tsx — a single reply thread in a Drawer: messages, mark-done / snooze actions, and a quick-reply
// box. Every mutation is honest about the unbuilt M9 backend — actions and sends that aren't wired yet surface a
// quiet "not available" toast instead of faking success.
"use client";

import { Drawer, EmptyState, StateSwitch, StatusBadge, TpButton, TpTextarea, useToast } from "@leadwolf/ui";
import { useEffect, useState } from "react";
import { fetchThread, sendReply, updateThread } from "../api";
import { formatRelative } from "../format";
import type { InboxThread } from "../types";
import styles from "../inbox.module.css";

export function ThreadView({
  threadId,
  onClose,
  onChanged,
}: {
  threadId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!threadId) {
      setThread(null);
      setError(null);
      setReply("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchThread(threadId)
      .then((t) => {
        if (!cancelled) setThread(t);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load the conversation");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const act = async (status: "done" | "snoozed") => {
    if (!threadId) return;
    setBusy(true);
    try {
      const { ok } = await updateThread(threadId, { status });
      if (ok) {
        toast.success(status === "done" ? "Marked done" : "Snoozed");
        onChanged();
        onClose();
      } else {
        toast.toast({
          title: "Not available yet",
          description: "Reply actions ship with mailbox sync (M9).",
        });
      }
    } catch (e) {
      toast.error("Could not update", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!threadId || reply.trim().length === 0) return;
    setBusy(true);
    try {
      const { sent } = await sendReply(threadId, reply.trim());
      if (sent) {
        toast.success("Reply sent");
        setReply("");
        onChanged();
      } else {
        toast.toast({
          title: "Sending isn't available yet",
          description: "Replies send once mailbox sync ships (M9).",
        });
      }
    } catch (e) {
      toast.error("Could not send", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={threadId != null}
      onClose={onClose}
      title={thread?.contactName ?? "Conversation"}
      width={480}
      footer={
        <div className={styles.replyBox}>
          <TpTextarea
            placeholder="Write a quick reply…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
          />
          <TpButton onClick={send} disabled={busy || reply.trim().length === 0} loading={busy} full>
            Send reply
          </TpButton>
        </div>
      }
    >
      <StateSwitch
        loading={loading}
        error={error}
        empty={!loading && thread == null}
        emptyState={
          <EmptyState
            title="Conversation unavailable"
            description="This thread isn't available yet — reply ingestion ships with mailbox sync (M9)."
          />
        }
      >
        {thread != null ? (
          <div className={styles.detail}>
            <div className={styles.detailMeta}>
              {thread.contactTitle ? <span>{thread.contactTitle}</span> : null}
              {thread.accountName ? <span>· {thread.accountName}</span> : null}
              {thread.sequenceName ? (
                <StatusBadge tone="muted">{thread.sequenceName}</StatusBadge>
              ) : null}
            </div>
            <div className={styles.actions}>
              <TpButton variant="secondary" size="sm" onClick={() => act("done")} disabled={busy}>
                Mark done
              </TpButton>
              <TpButton variant="ghost" size="sm" onClick={() => act("snoozed")} disabled={busy}>
                Snooze
              </TpButton>
            </div>
            <ul className={styles.messages}>
              {(thread.messages ?? []).map((m) => (
                <li
                  key={m.id}
                  className={m.direction === "outbound" ? styles.messageOut : styles.messageIn}
                >
                  <span className={styles.messageBody}>{m.body}</span>
                  <span className={styles.messageTime}>{formatRelative(m.at)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </StateSwitch>
    </Drawer>
  );
}
