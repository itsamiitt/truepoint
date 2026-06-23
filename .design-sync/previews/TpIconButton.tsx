import { TpIconButton } from "@leadwolf/ui";
import type { ReactNode } from "react";

function Edit() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
    </svg>
  );
}

function Trash() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function More() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </svg>
  );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      {children}
      <span style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>{label}</span>
    </div>
  );
}

export function RowActions() {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <TpIconButton label="Edit contact">
        <Edit />
      </TpIconButton>
      <TpIconButton label="Delete contact">
        <Trash />
      </TpIconButton>
      <TpIconButton label="More options">
        <More />
      </TpIconButton>
    </div>
  );
}

export function States() {
  return (
    <div style={{ display: "flex", gap: 28, alignItems: "flex-start" }}>
      <Cell label="Default">
        <TpIconButton label="More options">
          <More />
        </TpIconButton>
      </Cell>
      <Cell label="Disabled">
        <TpIconButton label="Delete contact" disabled>
          <Trash />
        </TpIconButton>
      </Cell>
    </div>
  );
}
