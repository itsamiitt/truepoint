import { TpCheckbox } from "@leadwolf/ui";

export function Checked() {
  return <TpCheckbox label="Send me a weekly pipeline summary" defaultChecked />;
}

export function Unchecked() {
  return <TpCheckbox label="Also import contacts without an email address" />;
}

export function Group() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <TpCheckbox label="Email notifications" defaultChecked />
      <TpCheckbox label="In-app notifications" defaultChecked />
      <TpCheckbox label="SMS notifications" />
    </div>
  );
}

export function Disabled() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <TpCheckbox label="Two-factor authentication (required by your org)" defaultChecked disabled />
      <TpCheckbox label="Allow data export (contact an admin)" disabled />
    </div>
  );
}
