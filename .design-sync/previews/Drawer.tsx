import { Drawer, TpButton } from "@leadwolf/ui";
import type { ReactNode } from "react";

// Drawer renders a position:fixed scrim + edge panel. In a preview card we give it a sized,
// transformed stage so the fixed layer has a real containing block (otherwise it collapses/clips).
function Stage({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: "relative",
        height: 480,
        transform: "translateZ(0)",
        overflow: "hidden",
        borderRadius: 8,
        background: "var(--tp-surface)",
      }}
    >
      {/* faint page content behind the drawer so the slide-over context reads */}
      <div style={{ padding: 24, color: "var(--tp-ink-4)", fontSize: 13 }}>
        Contacts · 412 records
      </div>
      {children}
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--tp-ink-3)" }}>{label}</span>
      <div style={{ fontSize: 14, color: "var(--tp-ink)" }}>{children}</div>
    </label>
  );
}

export function ContactDetails() {
  return (
    <Stage>
      <Drawer
        open
        onClose={() => {}}
        title="Ava Thompson"
        side="right"
        footer={
          <>
            <TpButton variant="ghost" onClick={() => {}}>
              Cancel
            </TpButton>
            <TpButton variant="primary" onClick={() => {}}>
              Save
            </TpButton>
          </>
        }
      >
        <FieldRow label="Company">Northwind Traders</FieldRow>
        <FieldRow label="Email">ava@northwind.co</FieldRow>
        <FieldRow label="Stage">Qualified</FieldRow>
        <FieldRow label="Owner">Liam Chen</FieldRow>
        <p style={{ margin: 0, fontSize: 13, color: "var(--tp-ink-3)", lineHeight: 1.5 }}>
          Met at SaaStr. Evaluating for a 40-seat rollout in Q3; wants SSO and CSV export.
        </p>
      </Drawer>
    </Stage>
  );
}

export function FiltersLeft() {
  return (
    <Stage>
      <Drawer open onClose={() => {}} title="Filters" side="left" width={300}>
        <FieldRow label="Stage">Qualified, Proposal</FieldRow>
        <FieldRow label="Owner">Anyone on my team</FieldRow>
        <FieldRow label="Value">$2,000 – $10,000</FieldRow>
        <FieldRow label="Last activity">Within 14 days</FieldRow>
      </Drawer>
    </Stage>
  );
}
