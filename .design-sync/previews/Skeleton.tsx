import { Skeleton } from "@leadwolf/ui";

// A panel wrapper so skeleton blocks sit on a real card surface like they would in the app.
function Panel({ children, width = 360 }: { children: import("react").ReactNode; width?: number }) {
  return (
    <div
      style={{
        width,
        padding: 16,
        border: "1px solid var(--tp-hairline)",
        borderRadius: "var(--radius)",
        background: "var(--tp-surface)",
      }}
    >
      {children}
    </div>
  );
}

export function Bars() {
  return (
    <Panel>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Skeleton width="40%" height={16} />
        <Skeleton height={11} />
        <Skeleton width="88%" height={11} />
        <Skeleton width="62%" height={11} />
      </div>
    </Panel>
  );
}

export function CardPlaceholder() {
  return (
    <Panel>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <Skeleton width={44} height={44} radius="50%" />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <Skeleton width="55%" height={13} />
          <Skeleton width="35%" height={10} />
        </div>
      </div>
      <Skeleton height={120} radius="var(--radius)" />
    </Panel>
  );
}

export function StatRow() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            padding: 16,
            border: "1px solid var(--tp-hairline)",
            borderRadius: "var(--radius)",
            background: "var(--tp-surface)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <Skeleton width="60%" height={10} />
          <Skeleton width="45%" height={22} />
          <Skeleton width="75%" height={9} />
        </div>
      ))}
    </div>
  );
}
