// ContactsTable.tsx — presentation of the workspace's masked contacts (no PII; reveal lands in M3). Email
// shows only the non-PII domain facet with a masked local part; a lock glyph marks fields that exist but
// are hidden until reveal. Pure presentation — data comes from useContacts via the parent.

import type { MaskedContact } from "@leadwolf/types";
import { type Column, DataTable, EmptyState } from "@leadwolf/ui";

function maskedEmail(c: MaskedContact): string {
  if (!c.hasEmail) return "—";
  return c.emailDomain ? `•••@${c.emailDomain}` : "••• (hidden)";
}

const COLUMNS: Column<MaskedContact>[] = [
  {
    key: "name",
    header: "Name",
    cell: (c) => [c.firstName, c.lastName].filter(Boolean).join(" ") || "—",
  },
  { key: "title", header: "Title", cell: (c) => c.jobTitle ?? "—" },
  { key: "email", header: "Email", cell: (c) => maskedEmail(c) },
  { key: "status", header: "Status", cell: (c) => c.emailStatus },
  { key: "phone", header: "Phone", cell: (c) => (c.hasPhone ? "🔒 masked" : "—") },
  {
    key: "location",
    header: "Location",
    cell: (c) => [c.locationCity, c.locationCountry].filter(Boolean).join(", ") || "—",
  },
];

export function ContactsTable({ contacts }: { contacts: MaskedContact[] }) {
  return (
    <DataTable
      columns={COLUMNS}
      rows={contacts}
      rowKey={(c) => c.id}
      empty={
        <EmptyState
          title="No contacts yet"
          description="Import a CSV above to populate this workspace."
        />
      }
    />
  );
}
