import { TpSelect } from "@leadwolf/ui";
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
    <Field label="Deal stage" hint="Drives the pipeline column.">
      <TpSelect defaultValue="qualified">
        <option value="new">New</option>
        <option value="qualified">Qualified</option>
        <option value="proposal">Proposal sent</option>
        <option value="won">Closed won</option>
        <option value="lost">Closed lost</option>
      </TpSelect>
    </Field>
  );
}

export function Placeholder() {
  return (
    <Field label="Assign owner">
      <TpSelect defaultValue="">
        <option value="" disabled>
          Select a teammate…
        </option>
        <option value="ava">Ava Thompson</option>
        <option value="liam">Liam Chen</option>
        <option value="noah">Noah Patel</option>
      </TpSelect>
    </Field>
  );
}

export function Invalid() {
  return (
    <Field
      label="Lead source"
      hint={<span style={{ color: "var(--danger)" }}>Choose a source before saving.</span>}
    >
      <TpSelect defaultValue="" invalid>
        <option value="" disabled>
          Select a source…
        </option>
        <option value="referral">Referral</option>
        <option value="website">Website form</option>
        <option value="event">Event</option>
      </TpSelect>
    </Field>
  );
}

export function Disabled() {
  return (
    <Field label="Workspace" hint="Set by your administrator.">
      <TpSelect defaultValue="acme" disabled>
        <option value="acme">Acme Co. — Sales</option>
      </TpSelect>
    </Field>
  );
}
