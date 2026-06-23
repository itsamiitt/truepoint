import { TpChip } from "@leadwolf/ui";

export function Tags() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <TpChip>Enterprise</TpChip>
      <TpChip>Inbound</TpChip>
      <TpChip>High intent</TpChip>
      <TpChip>Newsletter</TpChip>
    </div>
  );
}

export function FilterFacets() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <TpChip active onClick={() => {}}>
        All
      </TpChip>
      <TpChip onClick={() => {}}>Qualified</TpChip>
      <TpChip onClick={() => {}}>Proposal sent</TpChip>
      <TpChip onClick={() => {}}>Closed won</TpChip>
    </div>
  );
}

export function Removable() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <TpChip onRemove={() => {}}>San Francisco</TpChip>
      <TpChip onRemove={() => {}}>Referral</TpChip>
      <TpChip onRemove={() => {}}>VIP</TpChip>
    </div>
  );
}
