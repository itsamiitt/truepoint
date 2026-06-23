// AuthAuditList.tsx — the read-only recent-auth-events table inside Tenant ▸ Security & access. Self-loads
// the org's last 100 auth events (login / MFA / SSO / session / token) via the security-admin-gated API and
// renders them with the four-state StateSwitch. Security-review signals only (event / user / IP / origin /
// time) — never tokens or full PII. Presentation only; data flows through the slice's api seam.
"use client";

import type { AuthAuditEntry } from "@leadwolf/types";
import { type Column, DataTable, EmptyState, StateSwitch } from "@leadwolf/ui";
import { History } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchAuthAudit } from "../api";

const columns: Column<AuthAuditEntry>[] = [
  { key: "action", header: "Event", sortValue: (e) => e.action, cell: (e) => e.action },
  {
    key: "actor",
    header: "User",
    cell: (e) => (e.actorUserId ? e.actorUserId.slice(0, 8) : "system"),
  },
  { key: "ip", header: "IP", cell: (e) => e.ipAddress ?? "—" },
  { key: "origin", header: "Origin", cell: (e) => e.originDomain ?? "—" },
  {
    key: "time",
    header: "When",
    align: "right",
    sortValue: (e) => e.occurredAt,
    cell: (e) => new Date(e.occurredAt).toLocaleString(),
  },
];

export function AuthAuditList() {
  const [events, setEvents] = useState<AuthAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const e = await fetchAuthAudit();
        if (active) setEvents(e);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Failed to load auth events");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <StateSwitch
      loading={loading}
      error={error}
      empty={events.length === 0}
      emptyState={
        <EmptyState
          icon={<History size={28} />}
          title="No auth events yet"
          description="Sign-ins, MFA challenges, and session changes for your org will appear here."
        />
      }
    >
      <DataTable columns={columns} rows={events} rowKey={(e) => e.id} />
    </StateSwitch>
  );
}
