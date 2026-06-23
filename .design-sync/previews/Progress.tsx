import { Progress } from "@leadwolf/ui";

export function Values() {
  const rows: Array<[string, number]> = [
    ["Warm-up", 30],
    ["Import", 70],
    ["Complete", 100],
  ];
  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 280 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span style={{ color: "var(--tp-ink-3)" }}>{label}</span>
            <span style={{ color: "var(--tp-ink-2)", fontWeight: 500 }}>{value}%</span>
          </div>
          <Progress value={value} />
        </div>
      ))}
    </div>
  );
}

export function Tones() {
  const rows: Array<{ label: string; value: number; tone: "ink" | "cobalt" | "success" | "warning" | "danger" }> = [
    { label: "Default", value: 60, tone: "ink" },
    { label: "Cobalt", value: 45, tone: "cobalt" },
    { label: "Healthy", value: 92, tone: "success" },
    { label: "Throttled", value: 55, tone: "warning" },
    { label: "Over quota", value: 80, tone: "danger" },
  ];
  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 280 }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>{r.label}</span>
          <Progress value={r.value} tone={r.tone} />
        </div>
      ))}
    </div>
  );
}

export function Single() {
  return (
    <div style={{ display: "grid", gap: 8, maxWidth: 300 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <span style={{ color: "var(--tp-ink-2)", fontWeight: 500 }}>Mailbox warm-up</span>
        <span style={{ color: "var(--tp-ink-4)" }}>Day 12 of 30</span>
      </div>
      <Progress value={40} tone="cobalt" />
    </div>
  );
}
