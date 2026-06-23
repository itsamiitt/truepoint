import { TpTextarea } from "@leadwolf/ui";
import type { ReactNode } from "react";

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 380 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--tp-ink)" }}>{label}</span>
      {children}
      {hint != null ? <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>{hint}</span> : null}
    </label>
  );
}

export function Default() {
  return (
    <Field label="Note" hint="Visible to everyone on the deal.">
      <TpTextarea
        rows={4}
        defaultValue={
          "Spoke with Ava on Tuesday — they're evaluating us against two competitors. Decision expected by end of Q2. Send the enterprise pricing one-pager."
        }
      />
    </Field>
  );
}

export function Placeholder() {
  return (
    <Field label="Outreach message">
      <TpTextarea rows={4} placeholder="Write a short, personalized intro to Liam at Acme Co.…" />
    </Field>
  );
}

export function Invalid() {
  return (
    <Field
      label="Reason for closing"
      hint={<span style={{ color: "var(--danger)" }}>A reason is required to close this deal.</span>}
    >
      <TpTextarea rows={3} defaultValue="" invalid />
    </Field>
  );
}

export function Disabled() {
  return (
    <Field label="Imported summary" hint="Generated from the last sync — read only.">
      <TpTextarea
        rows={3}
        disabled
        defaultValue={"Source: HubSpot export (2,847 contacts). Last synced 2 minutes ago."}
      />
    </Field>
  );
}
