// SessionsPanel.tsx — Workspace ▸ Security ▸ Sessions (G-AUTH-2): a DataTable of the active sessions of this
// workspace's members, with a confirmed "Revoke" per session and a "Sign out everywhere" (force re-auth) per
// member. Empty-first against the unbuilt sessions API; admin authorization + auditing are enforced server-
// side. A revoked session can no longer refresh, so the member must sign in again.
"use client";

import {
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  StateSwitch,
  StatusBadge,
  TpButton,
  useToast,
} from "@leadwolf/ui";
import { MonitorSmartphone } from "lucide-react";
import { useState } from "react";
import { useSessions } from "../hooks/useSessions";
import styles from "../settings-workspace.module.css";
import type { WorkspaceSession } from "../types";

/** A compact, human-readable device label from a raw User-Agent (best-effort; falls back to the raw string). */
function deviceLabel(ua?: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua) && !/Chromium/.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua) && !/Chrome/.test(ua)
          ? "Safari"
          : null;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iOS/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} · ${os}`;
  return browser ?? os ?? ua;
}

function formatWhen(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function SessionsPanel() {
  const toast = useToast();
  const { feed, loading, error, reload, revoke, forceReauth } = useSessions();
  const [toRevoke, setToRevoke] = useState<WorkspaceSession | null>(null);
  const [toReauth, setToReauth] = useState<WorkspaceSession | null>(null);
  const [busy, setBusy] = useState(false);

  const notWired = () =>
    toast.toast({
      title: "Not available yet",
      description: "Session management connects once the API ships.",
    });

  const onRevoke = async () => {
    if (!toRevoke) return;
    setBusy(true);
    try {
      const ok = await revoke(toRevoke.id);
      if (ok) toast.success("Session revoked");
      else notWired();
    } catch (e) {
      toast.error("Could not revoke", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
      setToRevoke(null);
    }
  };

  const onForceReauth = async () => {
    if (!toReauth) return;
    setBusy(true);
    try {
      const ok = await forceReauth(toReauth.userId);
      if (ok) toast.success("Signed out of all sessions", toReauth.userEmail);
      else notWired();
    } catch (e) {
      toast.error("Could not sign the member out", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
      setToReauth(null);
    }
  };

  const columns: Column<WorkspaceSession>[] = [
    {
      key: "member",
      header: "Member",
      sortValue: (s) => s.userEmail,
      cell: (s) => (
        <span className={styles.memberCell}>
          <span className={styles.memberEmail}>{s.userEmail}</span>
          {s.userName ? <span className={styles.memberName}>{s.userName}</span> : null}
        </span>
      ),
    },
    {
      key: "device",
      header: "Device",
      cell: (s) => (
        <span className={styles.deviceCell} title={s.userAgent ?? undefined}>
          {deviceLabel(s.userAgent)}
        </span>
      ),
    },
    {
      key: "ip",
      header: "IP address",
      cell: (s) => <span className={styles.mono}>{s.ipAddress ?? "—"}</span>,
    },
    {
      key: "lastSeen",
      header: "Last active",
      sortValue: (s) => s.lastSeenAt ?? s.createdAt,
      cell: (s) => <span className={styles.mono}>{formatWhen(s.lastSeenAt ?? s.createdAt)}</span>,
    },
    {
      key: "status",
      header: "",
      cell: (s) => (s.current ? <StatusBadge tone="success">This device</StatusBadge> : null),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (s) => (
        <span className={styles.sessionActions}>
          <TpButton variant="ghost" size="sm" onClick={() => setToReauth(s)}>
            Sign out everywhere
          </TpButton>
          <TpButton variant="danger" size="sm" onClick={() => setToRevoke(s)}>
            Revoke
          </TpButton>
        </span>
      ),
    },
  ];

  return (
    <section>
      <h1 className="tp-settings-title">Active sessions</h1>
      <p className={styles.panelIntro}>
        Review where members of this workspace are signed in, and revoke a session or sign a member
        out of every device. A revoked session can no longer be used to sign in.
      </p>
      <StateSwitch
        loading={loading}
        error={error}
        empty={feed != null && feed.sessions.length === 0}
        onRetry={reload}
        emptyState={
          <EmptyState
            icon={<MonitorSmartphone size={28} />}
            title={feed?.available ? "No active sessions" : "Sessions API not connected"}
            description={
              feed?.available
                ? "Member sessions in this workspace will appear here."
                : "Once the sessions API ships, active member sessions will appear here."
            }
          />
        }
      >
        <DataTable columns={columns} rows={feed?.sessions ?? []} rowKey={(s) => s.id} />
      </StateSwitch>
      <Dialog
        open={toRevoke != null}
        onClose={() => (busy ? undefined : setToRevoke(null))}
        title="Revoke this session?"
        description={
          toRevoke
            ? toRevoke.current
              ? `This is your current session — revoking it will sign you out of ${toRevoke.userEmail}.`
              : `${toRevoke.userEmail} will be signed out on this device and must sign in again.`
            : undefined
        }
        footer={
          <>
            <TpButton variant="ghost" onClick={() => setToRevoke(null)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton variant="danger" onClick={onRevoke} loading={busy}>
              Revoke
            </TpButton>
          </>
        }
      />
      <Dialog
        open={toReauth != null}
        onClose={() => (busy ? undefined : setToReauth(null))}
        title="Sign this member out of every device?"
        description={
          toReauth
            ? toReauth.current
              ? `This includes your own current session — you will be signed out of ${toReauth.userEmail}.`
              : `${toReauth.userEmail} will be signed out of all sessions in this workspace and must sign in again.`
            : undefined
        }
        footer={
          <>
            <TpButton variant="ghost" onClick={() => setToReauth(null)} disabled={busy}>
              Cancel
            </TpButton>
            <TpButton variant="danger" onClick={onForceReauth} loading={busy}>
              Sign out everywhere
            </TpButton>
          </>
        }
      />
    </section>
  );
}
