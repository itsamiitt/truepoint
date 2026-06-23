import { Card, StatusBadge } from "@leadwolf/ui";

export function Panel() {
  return (
    <div style={{ maxWidth: 360 }}>
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--tp-ink)" }}>
            Acme Corp
          </h3>
          <StatusBadge tone="success">Active</StatusBadge>
        </div>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--tp-ink-3)" }}>
          Enterprise plan · 240 seats. Primary contact synced 4 minutes ago from
          HubSpot. Next renewal on Mar 14, 2026.
        </p>
      </Card>
    </div>
  );
}

export function DetailRows() {
  const rows: Array<[string, string]> = [
    ["Owner", "Dana Whitfield"],
    ["Source", "Inbound — webinar"],
    ["Stage", "Negotiation"],
    ["Last touch", "2 days ago"],
  ];
  return (
    <div style={{ maxWidth: 340 }}>
      <Card>
        <h3 style={{ margin: "0 0 14px", fontSize: 15, fontWeight: 600, color: "var(--tp-ink)" }}>
          Deal summary
        </h3>
        <div style={{ display: "grid", gap: 10 }}>
          {rows.map(([k, v]) => (
            <div
              key={k}
              style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}
            >
              <span style={{ color: "var(--tp-ink-4)" }}>{k}</span>
              <span style={{ color: "var(--tp-ink-2)", fontWeight: 500 }}>{v}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function Grid() {
  const items = [
    { title: "Open deals", body: "64 deals worth $184,200 in pipeline." },
    { title: "Tasks due", body: "12 follow-ups scheduled for today." },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 560 }}>
      {items.map((it) => (
        <Card key={it.title}>
          <h3 style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 600, color: "var(--tp-ink)" }}>
            {it.title}
          </h3>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--tp-ink-3)" }}>
            {it.body}
          </p>
        </Card>
      ))}
    </div>
  );
}
