import { Combobox } from "@leadwolf/ui";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

// Combobox owns its open/query state internally (no controlled `open` prop). To show the open
// listbox in a static screenshot, click the trigger button once on mount.
function AutoOpen({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const btn = ref.current?.querySelector("button");
    if (btn) (btn as HTMLButtonElement).click();
  }, []);
  return <div ref={ref}>{children}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, width: 280 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--tp-ink)" }}>{label}</span>
      {children}
    </label>
  );
}

const owners = [
  { value: "ava", label: "Ava Thompson", hint: "Sales" },
  { value: "liam", label: "Liam Chen", hint: "Sales" },
  { value: "noah", label: "Noah Patel", hint: "SDR" },
  { value: "mia", label: "Mia Rodriguez", hint: "AE" },
  { value: "owen", label: "Owen Brooks", hint: "SDR" },
];

export function OpenOwnerPicker() {
  const [value, setValue] = useState<string | null>("liam");
  return (
    // Stage gives the downward listbox room so it isn't clipped by the card.
    <div style={{ padding: "0 0 220px" }}>
      <Field label="Assign owner">
        <AutoOpen>
          <Combobox options={owners} value={value} onChange={setValue} placeholder="Select a teammate…" />
        </AutoOpen>
      </Field>
    </div>
  );
}

export function SelectedClosed() {
  const [value, setValue] = useState<string | null>("ava");
  return (
    <Field label="Deal owner">
      <Combobox options={owners} value={value} onChange={setValue} placeholder="Select a teammate…" />
    </Field>
  );
}

const templates = [
  { value: "intro", label: "Cold intro — short" },
  { value: "followup", label: "Follow-up after demo" },
  { value: "breakup", label: "Break-up email" },
  { value: "renewal", label: "Renewal nudge" },
];

export function TemplatePicker() {
  const [value, setValue] = useState<string | null>("followup");
  return (
    <Field label="Email template">
      <Combobox
        options={templates}
        value={value}
        onChange={setValue}
        placeholder="Pick a template…"
      />
    </Field>
  );
}
