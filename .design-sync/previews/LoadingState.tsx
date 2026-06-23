import { LoadingState } from "@leadwolf/ui";

// A card surface so the skeleton rows read like a loading list/panel in the app.
function Panel({ children, width = 380 }: { children: import("react").ReactNode; width?: number }) {
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

export function ContactList() {
  return (
    <Panel>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--tp-ink-2)", marginBottom: 12 }}>
        Loading contacts…
      </div>
      <LoadingState rows={4} label="Loading contacts" />
    </Panel>
  );
}

export function Compact() {
  return (
    <Panel width={320}>
      <LoadingState rows={2} label="Loading activity" />
    </Panel>
  );
}

export function Tall() {
  return (
    <Panel>
      <LoadingState rows={6} label="Loading leads" />
    </Panel>
  );
}
