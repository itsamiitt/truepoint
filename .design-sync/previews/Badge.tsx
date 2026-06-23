import { Badge } from "@leadwolf/ui";

export function Variants() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
      <Badge>ada@acme.io</Badge>
      <Badge variant="success">Verified</Badge>
    </div>
  );
}

export function IdentifierChip() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <Badge>ada@acme.io</Badge>
      <a href="#" style={{ fontSize: 13, color: "var(--tp-cobalt)" }}>
        Change
      </a>
    </div>
  );
}

export function Statuses() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
      <Badge variant="success">Email confirmed</Badge>
      <Badge>Pending invite</Badge>
      <Badge>Free plan</Badge>
    </div>
  );
}
