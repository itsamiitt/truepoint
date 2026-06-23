import { DropdownMenu, TpButton } from "@leadwolf/ui";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

// DropdownMenu (built on Popover) owns its open state; the trigger render-prop exposes `toggle`.
// To show the open menu statically we capture `toggle` and call it once on mount.
function useAutoOpen() {
  const toggleRef = useRef<() => void>(() => {});
  const openedRef = useRef(false);
  useEffect(() => {
    if (!openedRef.current) {
      openedRef.current = true;
      toggleRef.current();
    }
  }, []);
  return toggleRef;
}

// Menu opens downward, anchored to the trigger — leave room below it in the card.
function Stage({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "24px 24px 220px",
        background: "var(--tp-surface)",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      {children}
    </div>
  );
}

export function RowActions() {
  const toggleRef = useAutoOpen();
  return (
    <Stage>
      <DropdownMenu
        align="end"
        trigger={({ toggle, open }) => {
          toggleRef.current = toggle;
          return (
            <TpButton variant="secondary" onClick={toggle} aria-expanded={open}>
              Actions ▾
            </TpButton>
          );
        }}
        items={[
          { label: "Edit contact", icon: "✎", onSelect: () => {} },
          { label: "Add to sequence", icon: "↗", onSelect: () => {} },
          { label: "Assign owner", icon: "◍", onSelect: () => {} },
          { label: "Export", icon: "⤓", onSelect: () => {}, separatorBefore: true },
          { label: "Delete contact", icon: "🗑", danger: true, onSelect: () => {}, separatorBefore: true },
        ]}
      />
    </Stage>
  );
}

export function AccountMenu() {
  const toggleRef = useAutoOpen();
  return (
    <Stage>
      <DropdownMenu
        align="end"
        trigger={({ toggle, open }) => {
          toggleRef.current = toggle;
          return (
            <TpButton variant="ghost" onClick={toggle} aria-expanded={open}>
              Ava Thompson ▾
            </TpButton>
          );
        }}
        items={[
          { label: "Profile", onSelect: () => {} },
          { label: "Workspace settings", onSelect: () => {} },
          { label: "Switch workspace", onSelect: () => {} },
          { label: "Sign out", danger: true, onSelect: () => {}, separatorBefore: true },
        ]}
      />
    </Stage>
  );
}
