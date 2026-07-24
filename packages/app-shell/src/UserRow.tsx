// UserRow.tsx — the rail footer identity row: avatar + email + role, opening a menu whose only standard item
// is Sign out. Shared because all three apps rendered the same markup with a different role string (web derives
// it from the session, the staff consoles label it "Platform staff").
"use client";

import { Avatar, DropdownMenu } from "@leadwolf/ui";

export function UserRow({
  email,
  roleLabel,
  onSignOut,
  extraItems = [],
}: {
  email: string | null;
  /** Already-formatted role label — the caller decides how it reads. Named `roleLabel`, not `role`,
   *  so it never reads as the ARIA `role` attribute. */
  roleLabel: string;
  onSignOut: () => void;
  /** Optional app-specific menu rows placed above Sign out. */
  extraItems?: { label: string; onSelect: () => void }[];
}) {
  return (
    <DropdownMenu
      align="start"
      side="top"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          className="tp-user-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          <Avatar name={email} size={28} />
          <span className="tp-user-meta">
            <span className="tp-user-email">{email ?? "Signed in"}</span>
            <span className="tp-user-role">{roleLabel}</span>
          </span>
        </button>
      )}
      items={[...extraItems, { label: "Sign out", onSelect: onSignOut }]}
    />
  );
}
