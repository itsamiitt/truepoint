// ContactsTable.tsx — presentation of the workspace's masked contacts (no PII; reveal lands in M3). Email
// shows only the non-PII domain facet with a masked local part; a lock glyph marks fields that exist but
// are hidden until reveal. Pure presentation — data comes from useContacts via the parent.

import type { MaskedContact } from "@leadwolf/types";

function maskedEmail(c: MaskedContact): string {
  if (!c.hasEmail) return "—";
  return c.emailDomain ? `•••@${c.emailDomain}` : "••• (hidden)";
}

export function ContactsTable({ contacts }: { contacts: MaskedContact[] }) {
  if (contacts.length === 0) {
    return <p className="app-muted">No contacts yet — import a CSV above to populate this workspace.</p>;
  }
  return (
    <table className="lw-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Title</th>
          <th>Email</th>
          <th>Status</th>
          <th>Phone</th>
          <th>Location</th>
        </tr>
      </thead>
      <tbody>
        {contacts.map((c) => (
          <tr key={c.id}>
            <td>{[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}</td>
            <td>{c.jobTitle ?? "—"}</td>
            <td>{maskedEmail(c)}</td>
            <td>{c.emailStatus}</td>
            <td>{c.hasPhone ? "🔒 masked" : "—"}</td>
            <td>{[c.locationCity, c.locationCountry].filter(Boolean).join(", ") || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
