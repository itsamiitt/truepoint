import { TpSwitch } from "@leadwolf/ui";
import type { ReactNode } from "react";

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 24,
        maxWidth: 360,
      }}
    >
      <span style={{ fontSize: 14, color: "var(--tp-ink)" }}>{label}</span>
      {children}
    </div>
  );
}

export function On() {
  return (
    <Row label="Auto-enrich new contacts">
      <TpSwitch defaultChecked />
    </Row>
  );
}

export function Off() {
  return (
    <Row label="Share usage analytics">
      <TpSwitch />
    </Row>
  );
}

export function SettingsList() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Row label="Email notifications">
        <TpSwitch defaultChecked />
      </Row>
      <Row label="Weekly digest">
        <TpSwitch defaultChecked />
      </Row>
      <Row label="Product announcements">
        <TpSwitch />
      </Row>
    </div>
  );
}

export function Disabled() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Row label="Single sign-on (managed by org)">
        <TpSwitch defaultChecked disabled />
      </Row>
      <Row label="Public sharing (disabled by admin)">
        <TpSwitch disabled />
      </Row>
    </div>
  );
}
