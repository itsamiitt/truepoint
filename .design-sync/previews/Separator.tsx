import { Separator } from "@leadwolf/ui";

export function Hairline() {
  return (
    <div style={{ maxWidth: 360 }}>
      <p style={{ margin: 0, fontSize: 14, color: "var(--tp-ink-2)" }}>Account details</p>
      <Separator />
      <p style={{ margin: 0, fontSize: 14, color: "var(--tp-ink-2)" }}>Security settings</p>
    </div>
  );
}

export function WithLabel() {
  return (
    <div style={{ maxWidth: 360 }}>
      <p style={{ margin: 0, fontSize: 14, color: "var(--tp-ink-2)" }}>Continue with Google</p>
      <Separator label="or" />
      <p style={{ margin: 0, fontSize: 14, color: "var(--tp-ink-2)" }}>Sign in with email</p>
    </div>
  );
}
