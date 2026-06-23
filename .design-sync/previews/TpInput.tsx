import { TpInput } from "@leadwolf/ui";
import type { ReactNode } from "react";

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 320 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--tp-ink)" }}>{label}</span>
      {children}
      {hint != null ? <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>{hint}</span> : null}
    </label>
  );
}

export function Default() {
  return (
    <Field label="Work email" hint="We'll send the verification link here.">
      <TpInput type="email" defaultValue="ava.thompson@northwind.com" />
    </Field>
  );
}

export function Placeholder() {
  return (
    <Field label="Company name">
      <TpInput placeholder="e.g. Northwind Traders" />
    </Field>
  );
}

export function Invalid() {
  return (
    <Field
      label="Work email"
      hint={<span style={{ color: "var(--danger)" }}>Enter a valid email address.</span>}
    >
      <TpInput type="email" defaultValue="ava.thompson@" invalid />
    </Field>
  );
}

export function Disabled() {
  return (
    <Field label="Account ID" hint="Assigned automatically — read only.">
      <TpInput defaultValue="acct_8f21c094" disabled />
    </Field>
  );
}

export function Sizes() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 320 }}>
      <TpInput placeholder="Search contacts" defaultValue="Liam Chen" />
      <TpInput placeholder="Phone number" defaultValue="+1 (415) 555-0182" />
    </div>
  );
}
