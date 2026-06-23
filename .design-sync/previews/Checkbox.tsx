import { Checkbox } from "@leadwolf/ui";

export function WithLabel() {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--tp-ink)" }}>
      <Checkbox defaultChecked />
      Trust this device for 30 days
    </label>
  );
}

export function States() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--tp-ink)" }}>
        <Checkbox />
        Unchecked
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--tp-ink)" }}>
        <Checkbox defaultChecked />
        Checked
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--tp-ink-4)" }}>
        <Checkbox disabled />
        Disabled
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--tp-ink-4)" }}>
        <Checkbox disabled defaultChecked />
        Disabled, checked
      </label>
    </div>
  );
}
