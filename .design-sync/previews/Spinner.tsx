import { Spinner } from "@leadwolf/ui";

export function Inline() {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        borderRadius: "var(--radius)",
        background: "var(--tp-surface-2)",
        border: "1px solid var(--tp-hairline-2)",
        color: "var(--tp-ink-2)",
        fontSize: 13,
      }}
    >
      <Spinner />
      <span>Importing contacts…</span>
    </div>
  );
}

export function Sizes() {
  const sizes = [16, 24, 32];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
      {sizes.map((s) => (
        <div key={s} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          <Spinner size={s} />
          <span style={{ fontSize: 12, color: "var(--tp-ink-4)" }}>{s}px</span>
        </div>
      ))}
    </div>
  );
}

export function Centered() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        width: 240,
        height: 120,
        borderRadius: "var(--radius)",
        background: "var(--tp-surface-2)",
        border: "1px solid var(--tp-hairline-2)",
      }}
    >
      <Spinner size={28} />
      <span style={{ fontSize: 13, color: "var(--tp-ink-3)" }}>Loading dashboard…</span>
    </div>
  );
}
