import { StatusBadge } from "@leadwolf/ui";

export function Tones() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
      <StatusBadge tone="success">Verified</StatusBadge>
      <StatusBadge tone="warning">Pending</StatusBadge>
      <StatusBadge tone="danger">Bounced</StatusBadge>
      <StatusBadge tone="muted">Unsubscribed</StatusBadge>
    </div>
  );
}

export function EmailStatuses() {
  const rows: Array<{ email: string; tone: "success" | "warning" | "danger" | "muted"; label: string }> = [
    { email: "dana@acme.com", tone: "success", label: "Delivered" },
    { email: "leah@globex.io", tone: "warning", label: "Queued" },
    { email: "no-reply@old.test", tone: "danger", label: "Hard bounce" },
    { email: "sam@initech.com", tone: "muted", label: "No activity" },
  ];
  return (
    <div style={{ display: "grid", gap: 10, maxWidth: 300 }}>
      {rows.map((r) => (
        <div key={r.email} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13, color: "var(--tp-ink-2)" }}>{r.email}</span>
          <StatusBadge tone={r.tone}>{r.label}</StatusBadge>
        </div>
      ))}
    </div>
  );
}

export function Default() {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <StatusBadge>Draft</StatusBadge>
      <StatusBadge tone="success">Live</StatusBadge>
    </div>
  );
}
