import { TpButton } from "@leadwolf/ui";

export function Variants() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
      <TpButton variant="primary">Save changes</TpButton>
      <TpButton variant="secondary">Cancel</TpButton>
      <TpButton variant="ghost">Skip for now</TpButton>
      <TpButton variant="danger">Delete account</TpButton>
      <TpButton variant="link">Learn more</TpButton>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <TpButton size="md">Medium</TpButton>
      <TpButton size="sm">Small</TpButton>
    </div>
  );
}

export function States() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <TpButton loading>Saving…</TpButton>
      <TpButton disabled>Disabled</TpButton>
      <TpButton variant="secondary" disabled>
        Unavailable
      </TpButton>
    </div>
  );
}

export function FullWidth() {
  return (
    <div style={{ maxWidth: 320 }}>
      <TpButton full>Continue to checkout</TpButton>
    </div>
  );
}
