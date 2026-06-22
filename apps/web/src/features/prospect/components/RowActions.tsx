// RowActions.tsx — the compact per-row overflow menu for a prospect result (24, 04 §5): a small icon-button
// trigger opening a DropdownMenu of single-row actions. Email is disabled until the contact is revealed (the
// masked row has no address to mailto — we surface a hint, never a fabricated address); every other item is
// rendered ONLY when its callback is supplied, so the row shows exactly the actions the caller wired. The actual
// list/tag/status/reveal mutations live behind the supplied callbacks — this is presentation + dispatch only.
"use client";

import type { MaskedContact } from "@leadwolf/types";
import { DropdownMenu, type MenuItem, TpIconButton } from "@leadwolf/ui";
import { ExternalLink, ListPlus, Mail, MoreHorizontal, Tag, Workflow } from "lucide-react";

export function RowActions({
  contact,
  onAddToList,
  onTag,
  onChangeStatus,
  onOpenLinkedin,
}: {
  /** The row this menu acts on (drives the Email-until-revealed gate). */
  contact: MaskedContact;
  onAddToList?: () => void;
  onTag?: () => void;
  onChangeStatus?: () => void;
  /** Open the contact's LinkedIn. Omit when the row has no LinkedIn url — the item is then hidden. */
  onOpenLinkedin?: () => void;
}) {
  const items: MenuItem[] = [];

  // Email is a state hint, not a live action: the masked row never carries an address (revealing + composing
  // is RecordDetail's job, server-gated), so we never build a mailto from masked data. Inert in every state —
  // labelled by reveal status so the row honestly says whether emailing is possible.
  items.push({
    label: !contact.hasEmail
      ? "No email"
      : contact.isRevealed
        ? "Email — open record"
        : "Email — reveal first",
    icon: <Mail size={15} />,
    // No onSelect = inert; the full compose path lives behind "Open full record" / RecordDetail.
  });

  if (onOpenLinkedin)
    items.push({
      label: "Open LinkedIn",
      icon: <ExternalLink size={15} />,
      onSelect: onOpenLinkedin,
      separatorBefore: true,
    });

  if (onAddToList)
    items.push({
      label: "Add to list",
      icon: <ListPlus size={15} />,
      onSelect: onAddToList,
      separatorBefore: !onOpenLinkedin,
    });

  if (onTag) items.push({ label: "Tag", icon: <Tag size={15} />, onSelect: onTag });

  if (onChangeStatus)
    items.push({
      label: "Change status",
      icon: <Workflow size={15} />,
      onSelect: onChangeStatus,
    });

  return (
    <DropdownMenu
      align="end"
      trigger={({ toggle }) => (
        <TpIconButton label="Row actions" onClick={toggle}>
          <MoreHorizontal size={16} />
        </TpIconButton>
      )}
      items={items}
    />
  );
}
