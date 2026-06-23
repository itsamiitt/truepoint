import { EmptyState, Icon, StateSwitch, TpButton } from "@leadwolf/ui";
import { Users } from "./_glyphs";

// A card surface so each branch reads like a real async panel in the app.
function Panel({ children, width = 420 }: { children: import("react").ReactNode; width?: number }) {
  return (
    <div
      style={{
        width,
        minHeight: 180,
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

function ContactRows() {
  const rows = [
    { name: "Dana Whitfield", company: "Acme Corp" },
    { name: "Marcus Lee", company: "Northwind" },
    { name: "Priya Nair", company: "Lumen Labs" },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {rows.map((r) => (
        <div
          key={r.name}
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "10px 4px",
            borderBottom: "1px solid var(--tp-hairline-2)",
            fontSize: 13,
          }}
        >
          <span style={{ color: "var(--tp-ink)", fontWeight: 500 }}>{r.name}</span>
          <span style={{ color: "var(--tp-ink-3)" }}>{r.company}</span>
        </div>
      ))}
    </div>
  );
}

export function Loading() {
  return (
    <Panel>
      <StateSwitch loading>
        <ContactRows />
      </StateSwitch>
    </Panel>
  );
}

export function Empty() {
  return (
    <Panel>
      <StateSwitch
        empty
        emptyState={
          <EmptyState
            icon={<Icon icon={Users} size={28} />}
            title="No contacts yet"
            description="Import a CSV to populate this list."
            action={<TpButton variant="primary">Import contacts</TpButton>}
          />
        }
      >
        <ContactRows />
      </StateSwitch>
    </Panel>
  );
}

export function ErrorBranch() {
  return (
    <Panel>
      <StateSwitch error="Request timed out after 30s" onRetry={() => {}}>
        <ContactRows />
      </StateSwitch>
    </Panel>
  );
}

export function Content() {
  return (
    <Panel>
      <StateSwitch>
        <ContactRows />
      </StateSwitch>
    </Panel>
  );
}
