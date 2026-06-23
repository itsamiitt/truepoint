import { Button } from "@leadwolf/ui";

export function Variants() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
      <Button>Get started</Button>
      <Button variant="outline">Cancel</Button>
      <Button variant="ghost">Dismiss</Button>
      <Button variant="link">Forgot password?</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Button size="default">Default</Button>
      <Button size="sm">Small</Button>
    </div>
  );
}

export function States() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Button disabled>Disabled</Button>
      <Button variant="outline" disabled>
        Unavailable
      </Button>
    </div>
  );
}

export function FullWidth() {
  return (
    <div style={{ maxWidth: 320 }}>
      <Button size="full">Sign in</Button>
    </div>
  );
}
