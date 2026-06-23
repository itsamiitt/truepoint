import { FormRow, TpInput, TpSelect, TpSwitch } from "@leadwolf/ui";

function Panel({ children, width = 600 }: { children: import("react").ReactNode; width?: number }) {
  return (
    <div
      style={{
        width,
        padding: 24,
        border: "1px solid var(--tp-hairline)",
        borderRadius: "var(--radius)",
        background: "var(--tp-surface)",
        display: "flex",
        flexDirection: "column",
        gap: 24,
      }}
    >
      {children}
    </div>
  );
}

export function LabeledRows() {
  return (
    <Panel>
      <FormRow label="Workspace name" description="Shown across the app and in invites.">
        <TpInput defaultValue="Acme Revenue" />
      </FormRow>
      <FormRow label="Default currency" description="Used for all pipeline values.">
        <TpSelect defaultValue="usd">
          <option value="usd">USD — US Dollar</option>
          <option value="eur">EUR — Euro</option>
          <option value="gbp">GBP — British Pound</option>
        </TpSelect>
      </FormRow>
    </Panel>
  );
}

export function ToggleRow() {
  return (
    <Panel>
      <FormRow
        label="Auto-assign leads"
        description="Route new inbound leads to reps on a round-robin."
      >
        <TpSwitch defaultChecked />
      </FormRow>
      <FormRow
        label="Require approval"
        description="New campaigns must be approved before they send."
      >
        <TpSwitch />
      </FormRow>
    </Panel>
  );
}
